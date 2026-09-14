"""MCP server for subscription-first GUI work on the bound Orgo computer.

The server intentionally exposes one high-level tool and pins every run to the
computer configured by ``ORGO_DEFAULT_COMPUTER_ID``. The API key and computer
selection never enter the model-authored tool arguments.
"""

from __future__ import annotations

import asyncio
import fcntl
import os
import re
import tempfile
from contextlib import AbstractAsyncContextManager
from pathlib import Path
from typing import Annotated, Any, Literal

import httpx
from mcp.types import ToolAnnotations
from pydantic import BaseModel, Field

try:
    from mcp.server.mcpserver import MCPServer
    from mcp.server.mcpserver.exceptions import ToolError
except ImportError:  # MCP 1.x compatibility for older managed runtimes.
    from mcp.server.fastmcp import FastMCP as MCPServer
    from mcp.server.fastmcp.exceptions import ToolError

DEFAULT_MODEL = "claude-sonnet-5"
DEFAULT_MAX_STEPS = 30
DEFAULT_TIMEOUT_SECONDS = 900.0
DEFAULT_LOCK_WAIT_SECONDS = 5.0
MAX_STEPS_LIMIT = 100
MAX_TASK_LENGTH = 20_000
MAX_RESULT_LENGTH = 50_000
COMPUTER_ID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)

OrgoAgentModel = Literal[
    "claude-sonnet-5",
    "claude-opus-5",
    "claude-opus-4.8",
    "claude-sonnet-4.6",
    "claude-opus-4.6",
]


class OrgoAgentResult(BaseModel):
    """Structured result returned to Hermes."""

    text: str
    model: str
    computer_id: str
    max_steps: int
    response_id: str | None = None
    thread_id: str | None = None
    usage: dict[str, int] | None = None
    elapsed_seconds: float | None = None


class OrgoAgentRequestError(RuntimeError):
    """Safe, model-readable Orgo request failure."""


def _positive_float_env(name: str, default: float) -> float:
    try:
        value = float(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


def _default_max_steps() -> int:
    try:
        value = int(os.environ.get("ORGO_AGENT_MAX_STEPS", str(DEFAULT_MAX_STEPS)))
    except (TypeError, ValueError):
        return DEFAULT_MAX_STEPS
    return min(MAX_STEPS_LIMIT, max(1, value))


def _agent_endpoint() -> str:
    explicit = os.environ.get("ORGO_AGENT_API_URL", "").strip()
    if explicit:
        return explicit

    base = os.environ.get("ORGO_API_BASE_URL", "https://www.orgo.ai/api").strip().rstrip("/")
    if base.endswith("/v1"):
        return f"{base}/chat/completions"
    return f"{base}/v1/chat/completions"


def _credentials() -> tuple[str, str]:
    api_key = os.environ.get("ORGO_API_KEY", "").strip()
    computer_id = os.environ.get("ORGO_DEFAULT_COMPUTER_ID", "").strip()

    if not api_key:
        raise OrgoAgentRequestError("Orgo computer use is not configured: ORGO_API_KEY is missing.")
    if not COMPUTER_ID_RE.fullmatch(computer_id):
        raise OrgoAgentRequestError(
            "Orgo computer use is not configured: ORGO_DEFAULT_COMPUTER_ID is missing or invalid."
        )

    return api_key, computer_id


def _normalize_task(task: str) -> str:
    normalized = str(task or "").strip()
    if not normalized:
        raise OrgoAgentRequestError("Describe the computer task before starting an Orgo agent run.")
    if len(normalized) > MAX_TASK_LENGTH:
        raise OrgoAgentRequestError(
            f"The Orgo computer task is too long ({len(normalized)} characters; maximum {MAX_TASK_LENGTH})."
        )
    return normalized


def _normalize_max_steps(max_steps: int | None) -> int:
    try:
        value = _default_max_steps() if max_steps is None else int(max_steps)
    except (TypeError, ValueError) as exc:
        raise OrgoAgentRequestError("max_steps must be an integer.") from exc
    if not 1 <= value <= MAX_STEPS_LIMIT:
        raise OrgoAgentRequestError(f"max_steps must be between 1 and {MAX_STEPS_LIMIT}.")
    return value


def _response_text(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if not isinstance(content, list):
        return ""

    parts: list[str] = []
    for item in content:
        if isinstance(item, str):
            parts.append(item)
            continue
        if not isinstance(item, dict):
            continue
        text = item.get("text")
        if isinstance(text, str):
            parts.append(text)

    return "\n".join(part for part in parts if part).strip()


def _safe_error_message(status: int, payload: Any) -> str:
    detail = ""
    if isinstance(payload, dict):
        for key in ("error", "message", "detail"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                detail = value.strip()[:500]
                break

    if status == 401:
        return "Orgo rejected the configured API key. Reconnect Orgo in Orgo AI Guy Bot settings."
    if status == 402:
        return "The Orgo account has insufficient credits for this computer-use run."
    if status == 403:
        return detail or "The Orgo plan or API key does not allow this computer-use run."
    if status == 429:
        return "Orgo rate-limited the computer-use run. Wait a moment and try again."
    if status >= 500:
        return "Orgo's computer-use service is temporarily unavailable."
    return detail or f"Orgo rejected the computer-use request (HTTP {status})."


def _parse_result(payload: Any, *, computer_id: str, model: str, max_steps: int) -> OrgoAgentResult:
    if not isinstance(payload, dict):
        raise OrgoAgentRequestError("Orgo returned an invalid computer-use response.")

    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        raise OrgoAgentRequestError("Orgo returned a computer-use response without a completion.")

    message = choices[0].get("message")
    if not isinstance(message, dict):
        raise OrgoAgentRequestError("Orgo returned a computer-use response without a message.")

    text = _response_text(message.get("content"))
    if not text:
        raise OrgoAgentRequestError("Orgo completed the computer-use run without a text result.")

    raw_usage = payload.get("usage")
    usage = (
        {str(key): int(value) for key, value in raw_usage.items() if isinstance(value, int)}
        if isinstance(raw_usage, dict)
        else None
    )

    return OrgoAgentResult(
        text=text[:MAX_RESULT_LENGTH],
        model=str(payload.get("model") or model),
        computer_id=computer_id,
        max_steps=max_steps,
        response_id=str(payload["id"]) if payload.get("id") else None,
        thread_id=str(payload["thread_id"]) if payload.get("thread_id") else None,
        usage=usage or None,
    )


class _ComputerRunLock(AbstractAsyncContextManager[None]):
    """Cross-process lock: every profile shares the same VM and mouse."""

    def __init__(self, computer_id: str, wait_seconds: float) -> None:
        self._wait_seconds = wait_seconds
        self._path = Path(tempfile.gettempdir()) / f"hermes-orgo-agent-{computer_id}.lock"
        self._file: Any = None

    async def __aenter__(self) -> None:
        self._file = self._path.open("a+", encoding="utf-8")
        deadline = asyncio.get_running_loop().time() + self._wait_seconds

        while True:
            try:
                fcntl.flock(self._file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                return None
            except BlockingIOError:
                if asyncio.get_running_loop().time() >= deadline:
                    self._file.close()
                    self._file = None
                    raise OrgoAgentRequestError(
                        "Another agent is already controlling the shared Orgo computer. Wait for it to finish."
                    )
                await asyncio.sleep(0.25)

    async def __aexit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        if self._file is not None:
            fcntl.flock(self._file.fileno(), fcntl.LOCK_UN)
            self._file.close()
            self._file = None


async def run_orgo_agent(
    task: str,
    *,
    model: OrgoAgentModel = DEFAULT_MODEL,
    max_steps: int | None = None,
    client: httpx.AsyncClient | None = None,
) -> OrgoAgentResult:
    """Run one bounded delegated computer-use task."""

    api_key, computer_id = _credentials()
    normalized_task = _normalize_task(task)
    normalized_steps = _normalize_max_steps(max_steps)
    timeout_seconds = _positive_float_env("ORGO_AGENT_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS)
    lock_wait_seconds = _positive_float_env("ORGO_AGENT_LOCK_WAIT_SECONDS", DEFAULT_LOCK_WAIT_SECONDS)
    request_body = {
        "model": model,
        "computer_id": computer_id,
        "messages": [{"role": "user", "content": normalized_task}],
        "max_steps": normalized_steps,
    }

    async with _ComputerRunLock(computer_id, lock_wait_seconds):
        owns_client = client is None
        active_client = client or httpx.AsyncClient(
            timeout=httpx.Timeout(timeout_seconds, connect=min(30.0, timeout_seconds))
        )
        try:
            response = await active_client.post(
                _agent_endpoint(),
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json=request_body,
            )
        except httpx.TimeoutException as exc:
            raise OrgoAgentRequestError(
                f"The Orgo computer-use run exceeded {int(timeout_seconds)} seconds."
            ) from exc
        except httpx.HTTPError as exc:
            raise OrgoAgentRequestError("Could not reach Orgo's computer-use service.") from exc
        finally:
            if owns_client:
                await active_client.aclose()

    try:
        payload = response.json()
    except ValueError as exc:
        raise OrgoAgentRequestError("Orgo returned a non-JSON computer-use response.") from exc

    if not response.is_success:
        raise OrgoAgentRequestError(_safe_error_message(response.status_code, payload))

    return _parse_result(
        payload,
        computer_id=computer_id,
        model=model,
        max_steps=normalized_steps,
    )


mcp = MCPServer("Hermes Orgo Agent")


@mcp.tool(
    name="orgo_agent_run",
    title="Run Orgo computer-use agent",
    description=(
        "Actually operate this agent's visible browser and desktop on its Orgo computer. "
        "Use this for requests to open websites, search Google Images, click, type, or use applications. "
        "The worker uses ChatGPT subscription access with Luna, never an automatic paid-provider fallback. "
        "Give the complete task and return its verified result instead of giving the human commands to run."
    ),
    annotations=ToolAnnotations(
        readOnlyHint=False,
        destructiveHint=True,
        idempotentHint=False,
        openWorldHint=True,
    ),
)
async def orgo_agent_run(
    task: Annotated[
        str,
        Field(
            min_length=1,
            max_length=MAX_TASK_LENGTH,
            description="A complete, self-contained description of the visual computer task.",
        ),
    ],
    model: Annotated[
        Literal["gpt-5.6-luna"],
        Field(description="Subscription computer-use model; no paid-provider fallback."),
    ] = "gpt-5.6-luna",
    max_steps: Annotated[
        int | None,
        Field(
            ge=1,
            le=MAX_STEPS_LIMIT,
            description="Maximum screenshot/action loop steps. Defaults to 30.",
        ),
    ] = None,
) -> OrgoAgentResult:
    try:
        from hermes_cli.orgo_codex_worker import run
        from hermes_cli.orgo_screens import screen
        computer_id = os.environ.get("ORGO_DEFAULT_COMPUTER_ID", "")
        if not COMPUTER_ID_RE.fullmatch(computer_id):
            raise OrgoAgentRequestError("The Orgo computer binding is missing or invalid")
        profile = os.environ.get("ORGO_AGENT_PROFILE", "default")
        screen(profile)  # Validate host/profile before using them in a lock filename.
        steps = _normalize_max_steps(max_steps)
        async with _ComputerRunLock(computer_id + "-" + profile,
                                    _positive_float_env("ORGO_AGENT_LOCK_WAIT_SECONDS", DEFAULT_LOCK_WAIT_SECONDS)):
            result = await run(_normalize_task(task), max_steps=steps,
                               timeout=_positive_float_env("ORGO_AGENT_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS))
        return OrgoAgentResult(computer_id=computer_id, max_steps=steps, **result)
    except (RuntimeError, ValueError, OSError) as exc:
        raise ToolError(str(exc)) from exc


def main() -> None:
    # Desktop may upload this compatibility entrypoint as a standalone asset.
    # Resolve the explicitly installed worker runtime, never the machine's
    # unrelated global Hermes installation or a hosted paid-provider fallback.
    if Path(__file__).name == "orgo-agent-mcp.py":
        import json
        binding = Path("/root/.hermes/orgo-computer/runtime.json")
        if not binding.exists():
            raise RuntimeError("Install the subscription computer worker on this Orgo computer first")
        runtime = Path(json.loads(binding.read_text(encoding="utf-8"))["runtime"]).resolve()
        if not runtime.is_relative_to(Path("/root/.hermes/desktop-runtime")):
            raise RuntimeError("Invalid installed worker runtime")
        profile_home = Path(os.environ.get("HERMES_HOME", "/root/.hermes"))
        inferred = profile_home.name if profile_home.parent == Path("/root/.hermes/profiles") else "default"
        profile = os.environ.get("ORGO_AGENT_PROFILE") or inferred
        if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}", profile):
            raise RuntimeError("Invalid agent profile binding")
        env = {**os.environ, "PYTHONPATH": str(runtime), "ORGO_AGENT_PROFILE": profile,
               "PATH": "/root/.hermes/codex-worker/node_modules/.bin:/usr/local/bin:/usr/bin:/bin"}
        python = str(runtime / ".venv/bin/python")
        os.execve(python, [python, "-m", "hermes_cli.orgo_agent_mcp"], env)
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
