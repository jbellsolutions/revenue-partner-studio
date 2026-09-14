"""Real conversation -> terminal -> profile CLI, with a scripted loopback model.

This validates execution and isolation, not the planning ability of a paid model.
No gateway is started, no shell aliases are installed, and all data is synthetic.
"""

import contextlib
import json
import os
from pathlib import Path
import shlex
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
import yaml


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX terminal command acceptance")
@pytest.mark.timeout(120)
@pytest.mark.parametrize("already_exists", [False, True])
def test_operator_creates_and_discovers_specialist_without_cloning_history(tmp_path, already_exists):
    from hermes_state import SessionDB
    from run_agent import AIAgent

    home = Path(os.environ["HERMES_HOME"])
    assert home.is_relative_to(tmp_path), "Use only the test runner's isolated Hermes home"
    repo = Path(__file__).resolve().parents[2]
    specialist = "synthetic-specialist"
    commands = [
        shlex.join([sys.executable, "-m", "hermes_cli.main", "profile", "create",
                    specialist, "--clone-from", "default", "--no-alias",
                    "--description", "Synthetic arithmetic specialist"]),
        shlex.join([sys.executable, "-m", "hermes_cli.main", "profile", "list"]),
    ]
    requests = []

    class ScriptedModel(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if self.path != "/v1/chat/completions":
                self.send_error(404)
                return
            index = len(requests)
            requests.append(body)
            if index < len(commands):
                message = {
                    "role": "assistant", "content": None,
                    "tool_calls": [{"id": f"profile-step-{index}", "type": "function",
                                    "function": {"name": "terminal", "arguments": json.dumps({
                                        "command": commands[index], "workdir": str(repo), "timeout": 30,
                                    })}}],
                }
                finish = "tool_calls"
            else:
                message = {"role": "assistant", "content": "SYNTHETIC SPECIALIST DISCOVERED"}
                finish = "stop"
            common = {"id": f"synthetic-{index}", "created": 1, "model": "synthetic-operator"}
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream" if body.get("stream") else "application/json")
            self.end_headers()
            if body.get("stream"):
                delta = dict(message)
                if "tool_calls" in delta:
                    delta["tool_calls"] = [dict(call, index=n) for n, call in enumerate(delta["tool_calls"])]
                for chunk, reason in [(delta, None), ({}, finish)]:
                    event = dict(common, object="chat.completion.chunk",
                                 choices=[{"index": 0, "delta": chunk, "finish_reason": reason}])
                    self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
                self.wfile.write(b"data: [DONE]\n\n")
            else:
                response = dict(common, object="chat.completion", choices=[{
                    "index": 0, "message": message, "finish_reason": finish,
                }], usage={"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2})
                self.wfile.write(json.dumps(response).encode())
            self.wfile.flush()

    model = ThreadingHTTPServer(("127.0.0.1", 0), ScriptedModel)
    serving = threading.Thread(target=model.serve_forever, daemon=True)
    serving.start()
    endpoint = f"http://127.0.0.1:{model.server_port}/v1"
    config = {
        "model": {"default": "synthetic-operator", "provider": "mock"},
        "providers": {"mock": {"api": endpoint, "api_mode": "chat_completions",
                               "key_env": "MOCK_API_KEY", "models": {"synthetic-operator": {}}}},
        "toolsets": ["terminal"], "terminal": {"backend": "local", "cwd": str(home)},
        "compression": {"enabled": False}, "plugins": {"enabled": []},
        "security": {"allow_lazy_installs": False},
        "auxiliary": {"title_generation": {"enabled": False}},
    }
    (home / "config.yaml").write_text(json.dumps(config), encoding="utf-8")
    (home / ".env").write_text("MOCK_API_KEY=synthetic-local-only\n", encoding="utf-8")
    (home / "SOUL.md").write_text("Synthetic operator persona.", encoding="utf-8")
    created = home / "profiles" / specialist
    expected_soul = "Synthetic operator persona."
    expected_config = config
    if already_exists:
        created.mkdir(parents=True)
        expected_soul = "Existing specialist persona must survive a retry."
        expected_config = dict(config, description="Existing specialist settings")
        (created / "config.yaml").write_text(json.dumps(expected_config), encoding="utf-8")
        (created / "SOUL.md").write_text(expected_soul, encoding="utf-8")
        with contextlib.closing(SessionDB(db_path=created / "state.db")) as db:
            db.create_session("existing-specialist-history", "desktop")
            db.append_message("existing-specialist-history", "user", "SPECIALIST-ONLY-PRIVATE-HISTORY")
    agent = None
    try:
        with contextlib.closing(SessionDB(db_path=home / "state.db")) as db:
            db.create_session("private-operator-history", "desktop")
            db.append_message("private-operator-history", "user", "OPERATOR-ONLY-PRIVATE-HISTORY")
            agent = AIAgent(
                model="synthetic-operator", provider="openai", api_mode="chat_completions",
                base_url=endpoint, api_key="synthetic-local-only", max_iterations=4,
                enabled_toolsets=["terminal"], quiet_mode=True, skip_context_files=True,
                skip_memory=True, skip_background_review=True, session_db=db,
                session_id="synthetic-create-specialist", platform="desktop",
            )
            result = agent.run_conversation("Create a synthetic specialist, then list the profiles to discover it.")
            assert result["completed"] and not result.get("error"), result.get("error")
            assert result["final_response"] == "SYNTHETIC SPECIALIST DISCOVERED"
            assert len(requests) == 3
            model_context = json.dumps(requests)
            assert "OPERATOR-ONLY-PRIVATE-HISTORY" not in model_context
            assert "SPECIALIST-ONLY-PRIVATE-HISTORY" not in model_context
            assert "terminal" in {tool["function"]["name"] for tool in requests[0]["tools"]}
            tool_results = [message for message in requests[-1]["messages"] if message["role"] == "tool"]
            assert len(tool_results) == 2
            for step, tool_result in enumerate(tool_results):
                output = json.loads(tool_result["content"])
                if already_exists and step == 0:
                    assert output["exit_code"] != 0, output
                    assert "already exists" in output["output"], output
                else:
                    assert output["exit_code"] == 0, output
                assert specialist in output["output"], output
            assert db.get_messages("private-operator-history")[0]["content"] == "OPERATOR-ONLY-PRIVATE-HISTORY"
            assert db.get_session("existing-specialist-history") is None
            agent.close()
            agent = None

        assert created.is_dir()
        cloned = yaml.safe_load((created / "config.yaml").read_text(encoding="utf-8"))
        assert cloned["providers"] == config["providers"]
        if already_exists:
            assert cloned == expected_config
        assert (created / "SOUL.md").read_text(encoding="utf-8") == expected_soul
        if (created / "state.db").exists():
            with contextlib.closing(SessionDB(db_path=created / "state.db", read_only=True)) as db:
                assert db.get_session("private-operator-history") is None
                assert db.get_session("synthetic-create-specialist") is None
                if already_exists:
                    assert db.get_messages("existing-specialist-history")[0]["content"] == "SPECIALIST-ONLY-PRIVATE-HISTORY"
        assert not list((created / "sessions").glob("*.json"))
    finally:
        if agent is not None:
            agent.close()
        model.shutdown()
        model.server_close()
        serving.join(timeout=5)
        assert not serving.is_alive()
