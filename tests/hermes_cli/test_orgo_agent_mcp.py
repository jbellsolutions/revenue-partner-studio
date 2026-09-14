import asyncio
import json
import sys

import httpx
import pytest
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from hermes_cli.orgo_agent_mcp import (
    DEFAULT_MODEL,
    MAX_TASK_LENGTH,
    OrgoAgentRequestError,
    _ComputerRunLock,
    run_orgo_agent,
)

COMPUTER_ID = "ef2f6e29-3864-494b-a82c-15280c5d9f9e"


@pytest.fixture(autouse=True)
def orgo_env(monkeypatch):
    monkeypatch.setenv("ORGO_API_KEY", "orgo-secret")
    monkeypatch.setenv("ORGO_DEFAULT_COMPUTER_ID", COMPUTER_ID)
    monkeypatch.setenv("ORGO_AGENT_LOCK_WAIT_SECONDS", "0.1")
    monkeypatch.delenv("ORGO_AGENT_API_URL", raising=False)
    monkeypatch.delenv("ORGO_API_BASE_URL", raising=False)


@pytest.mark.asyncio
async def test_run_posts_bounded_task_to_configured_computer():
    async def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == "https://www.orgo.ai/api/v1/chat/completions"
        assert request.headers["Authorization"] == "Bearer orgo-secret"
        body = json.loads(request.content)
        assert body == {
            "model": DEFAULT_MODEL,
            "computer_id": COMPUTER_ID,
            "messages": [{"role": "user", "content": "Open Chrome and find the documentation"}],
            "max_steps": 12,
        }
        return httpx.Response(
            200,
            json={
                "id": "chatcmpl_123",
                "model": DEFAULT_MODEL,
                "thread_id": "thread_123",
                "choices": [{"message": {"content": "The documentation is open."}}],
                "usage": {"prompt_tokens": 120, "completion_tokens": 35, "ignored": "value"},
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await run_orgo_agent(
            "Open Chrome and find the documentation",
            max_steps=12,
            client=client,
        )

    assert result.text == "The documentation is open."
    assert result.computer_id == COMPUTER_ID
    assert result.response_id == "chatcmpl_123"
    assert result.thread_id == "thread_123"
    assert result.usage == {"prompt_tokens": 120, "completion_tokens": 35}


@pytest.mark.asyncio
async def test_run_normalizes_structured_text_content(monkeypatch):
    monkeypatch.setenv("ORGO_API_BASE_URL", "https://staging.orgo.example/api/v1")

    async def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == "https://staging.orgo.example/api/v1/chat/completions"
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": [
                                {"type": "text", "text": "First update"},
                                {"type": "text", "text": "Task complete"},
                            ]
                        }
                    }
                ]
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await run_orgo_agent("Complete the visual task", client=client)

    assert result.text == "First update\nTask complete"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "expected"),
    [
        (401, "rejected the configured API key"),
        (402, "insufficient credits"),
        (403, "plan does not include delegated agents"),
        (429, "rate-limited"),
        (503, "temporarily unavailable"),
    ],
)
async def test_run_returns_safe_actionable_api_errors(status, expected):
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json={"error": "plan does not include delegated agents"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(OrgoAgentRequestError, match=expected):
            await run_orgo_agent("Open the browser", client=client)


@pytest.mark.asyncio
async def test_run_rejects_missing_credentials_and_unbounded_input(monkeypatch):
    monkeypatch.delenv("ORGO_API_KEY")
    with pytest.raises(OrgoAgentRequestError, match="ORGO_API_KEY is missing"):
        await run_orgo_agent("Open the browser")

    monkeypatch.setenv("ORGO_API_KEY", "orgo-secret")
    with pytest.raises(OrgoAgentRequestError, match="too long"):
        await run_orgo_agent("x" * (MAX_TASK_LENGTH + 1))

    with pytest.raises(OrgoAgentRequestError, match="between 1 and 100"):
        await run_orgo_agent("Open the browser", max_steps=101)


@pytest.mark.asyncio
async def test_run_serializes_agents_sharing_one_computer():
    entered = asyncio.Event()
    release = asyncio.Event()

    async def handler(_request: httpx.Request) -> httpx.Response:
        entered.set()
        await release.wait()
        return httpx.Response(200, json={"choices": [{"message": {"content": "done"}}]})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as first_client:
        first = asyncio.create_task(run_orgo_agent("First task", client=first_client))
        await entered.wait()

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as second_client:
            with pytest.raises(OrgoAgentRequestError, match="already controlling"):
                await run_orgo_agent("Second task", client=second_client)

        release.set()
        assert (await first).text == "done"


@pytest.mark.asyncio
async def test_lock_releases_after_failure():
    async with _ComputerRunLock(COMPUTER_ID, 0.1):
        pass

    async with _ComputerRunLock(COMPUTER_ID, 0.1):
        pass


@pytest.mark.asyncio
async def test_run_rejects_malformed_success_response():
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"choices": []})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(OrgoAgentRequestError, match="without a completion"):
            await run_orgo_agent("Open the browser", client=client)


@pytest.mark.asyncio
async def test_stdio_server_exposes_only_bounded_model_authored_inputs():
    params = StdioServerParameters(
        command=sys.executable,
        args=["-m", "hermes_cli.orgo_agent_mcp"],
        env={
            "ORGO_API_KEY": "orgo-secret",
            "ORGO_DEFAULT_COMPUTER_ID": COMPUTER_ID,
        },
    )

    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()

    assert len(tools.tools) == 1
    tool = tools.tools[0]
    assert tool.name == "orgo_agent_run"
    assert tool.inputSchema["required"] == ["task"]
    assert set(tool.inputSchema["properties"]) == {"task", "model", "max_steps"}
    assert tool.annotations is not None
    assert tool.annotations.destructiveHint is True
    assert tool.annotations.openWorldHint is True
