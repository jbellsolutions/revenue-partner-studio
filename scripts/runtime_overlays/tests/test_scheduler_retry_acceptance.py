"""Manual real-gateway retry/restart acceptance with disposable local models.

Run explicitly via scripts/run_tests.sh. No production profiles, paid models,
manual dispatcher ticks, or mocked worker lifecycle hooks are used.
"""

import contextlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import sys
import threading
import time

import psutil

from test_runtime_acceptance import assert_startup_cleanup_isolated, eventually


def test_gateway_bounds_worker_retries_and_retains_exhaustion_after_restart(tmp_path, monkeypatch):
    assert_startup_cleanup_isolated(tmp_path, monkeypatch)
    from hermes_cli import kanban_db as kb
    from hermes_state import SessionDB

    runtime = Path.cwd()
    home = tmp_path / "synthetic-retry-home"
    home.mkdir()
    calls = []

    class Model(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            if self.path != "/v1/chat/completions":
                self.send_error(404)
                return
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            calls.append(body)
            if len(calls) > 24:
                self.send_error(503, "Synthetic acceptance request ceiling")
                return
            model_name = body["model"]
            results = [message for message in body.get("messages", []) if message.get("role") == "tool"]
            first_recovery_attempt = False
            if model_name == "mock-recover":
                with kb.connect_closing(home / "kanban.db") as board:
                    first_recovery_attempt = len(kb.list_runs(board, recover)) == 1
            fail = model_name == "mock-exhaust" or first_recovery_attempt
            # A clean worker exit without kanban_complete is a real protocol
            # failure. The gateway must classify and account for it itself.
            message = {"role": "assistant", "content": "SYNTHETIC WORKER EXIT WITHOUT COMPLETION"}
            finish = "stop"
            if not fail:
                message["content"] = "SYNTHETIC WORKER COMPLETED"
                if not results:
                    message.update(content=None, tool_calls=[{
                        "id": f"synthetic-complete-{len(calls)}", "type": "function",
                        "function": {"name": "kanban_complete", "arguments": json.dumps({
                            "summary": f"SYNTHETIC SUCCESS {model_name}",
                        })},
                    }])
                    finish = "tool_calls"
            common = {"id": f"synthetic-{len(calls)}", "created": int(time.time()), "model": model_name}
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream" if body.get("stream") else "application/json")
            self.end_headers()
            try:
                if body.get("stream"):
                    delta = dict(message)
                    if finish == "tool_calls":
                        delta["tool_calls"] = [dict(message["tool_calls"][0], index=0)]
                    for chunk, reason in [(delta, None), ({}, finish)]:
                        event = dict(common, object="chat.completion.chunk", choices=[{
                            "index": 0, "delta": chunk, "finish_reason": reason,
                        }])
                        self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
                    self.wfile.write(b"data: [DONE]\n\n")
                else:
                    self.wfile.write(json.dumps(dict(common, object="chat.completion", choices=[{
                        "index": 0, "message": message, "finish_reason": finish,
                    }], usage={"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2})).encode())
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass

    model = ThreadingHTTPServer(("127.0.0.1", 0), Model)
    serving = threading.Thread(target=model.serve_forever, daemon=True)
    names = ("mock-recover", "mock-exhaust", "mock-witness")
    config = {
        "model": {"default": "mock-recover", "provider": "mock"},
        "providers": {"mock": {"api": f"http://127.0.0.1:{model.server_port}/v1",
                               "api_mode": "chat_completions", "key_env": "MOCK_API_KEY",
                               "models": {name: {} for name in names}, "context_length": 32768}},
        "toolsets": ["kanban"], "terminal": {"backend": "local", "cwd": str(home)},
        # Leave room beyond the CLI's corrective nudges so this exercises a
        # clean uncompleted exit, not 0.21's iteration-budget failure path.
        "agent": {"max_turns": 5}, "compression": {"enabled": False}, "plugins": {"enabled": []},
        "security": {"allow_lazy_installs": False}, "auxiliary": {"title_generation": {"enabled": False}},
        "kanban": {"dispatch_in_gateway": True, "dispatch_interval_seconds": 1,
                   "auto_subscribe_on_create": False, "max_spawn": 1, "max_in_progress": 1,
                   "failure_limit": 1, "review_dispatch": False},
    }
    for target in (home, *(home / "profiles" / name for name in names)):
        target.mkdir(parents=True, exist_ok=True)
        (target / "config.yaml").write_text(json.dumps(config), encoding="utf-8")
        (target / ".env").write_text("MOCK_API_KEY=synthetic-local-only\n", encoding="utf-8")
        (target / "SOUL.md").write_text("Synthetic bounded retry acceptance only.", encoding="utf-8")
    with contextlib.closing(SessionDB(db_path=home / "state.db")) as db:
        db.create_session("private-unrelated-retry-thread", "desktop")
        db.append_message("private-unrelated-retry-thread", "user", "DO-NOT-SHARE-RETRY-PRIVATE-HISTORY")
    env = {"PATH": f"{runtime / '.venv/bin'}:/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8",
           "PYTHONUTF8": "1", "HERMES_HOME": str(home), "HERMES_DISABLE_LAZY_INSTALLS": "1",
           "MOCK_API_KEY": "synthetic-local-only"}
    scheduler = None
    log = (tmp_path / "retry-gateway.log").open("w", encoding="utf-8")

    def create(model_name, priority):
        with kb.connect_closing(home / "kanban.db") as board:
            return kb.create_task(board, title=f"Synthetic {model_name}", assignee=model_name,
                                  model_override=model_name, provider_override="mock", max_retries=2,
                                  max_runtime_seconds=45, priority=priority,
                                  workspace_kind="dir", workspace_path=str(home))

    def start():
        return subprocess.Popen([sys.executable, "-m", "gateway.run"], cwd=runtime, env=env,
                                stdout=log, stderr=subprocess.STDOUT)

    def stop():
        if scheduler and scheduler.poll() is None:
            owned = psutil.Process(scheduler.pid)
            captured = [owned, *owned.children(recursive=True)]
            for child in reversed(captured):
                with contextlib.suppress(psutil.NoSuchProcess):
                    child.terminate()
            _, alive = psutil.wait_procs(captured, timeout=8)
            for child in alive:
                with contextlib.suppress(psutil.NoSuchProcess):
                    child.kill()
            _, survivors = psutil.wait_procs(alive, timeout=3)
            assert not survivors
        if scheduler:
            scheduler.wait(timeout=5)

    def settled(task_id, status):
        assert scheduler.poll() is None, f"Gateway exited: see {log.name}"
        assert len(calls) <= 24, "Worker retry request ceiling exceeded"
        with kb.connect_closing(home / "kanban.db") as board:
            return kb.get_task(board, task_id).status == status

    serving.start()
    try:
        recover = create("mock-recover", 10)
        exhausted = create("mock-exhaust", 5)
        scheduler = start()
        eventually(lambda: settled(recover, "done"), timeout=100)
        eventually(lambda: settled(exhausted, "blocked"), timeout=100)
        with kb.connect_closing(home / "kanban.db") as board:
            recovered_runs = kb.list_runs(board, recover)
            exhausted_runs = kb.list_runs(board, exhausted)
            assert len(recovered_runs) == 2, "Recovery must use exactly the permitted second attempt"
            assert len(exhausted_runs) == 2, "Two permitted failures must not launch a third worker"
            assert sum(run.status == "done" for run in recovered_runs) == 1
            assert all(run.metadata.get("protocol_violation") for run in exhausted_runs)
            assert sum(event.kind == "gave_up" for event in kb.list_events(board, exhausted)) == 1
        print("CHECKPOINT recovered_once_and_stopped_at_failure_limit", flush=True)
        stop()
        scheduler = start()
        # A new task completing after restart is a positive dispatch barrier:
        # the loop really ran again, rather than merely sleeping while we read.
        witness = create("mock-witness", 0)
        eventually(lambda: settled(witness, "done"), timeout=60)
        with kb.connect_closing(home / "kanban.db") as board:
            assert kb.get_task(board, exhausted).status == "blocked"
            assert len(kb.list_runs(board, exhausted)) == 2
            assert len(kb.list_runs(board, recover)) == 2
            assert len(kb.list_runs(board, witness)) == 1
            for task_id in (recover, exhausted, witness):
                for run in kb.list_runs(board, task_id):
                    worker_session = run.metadata["worker_session_id"]
                    with contextlib.closing(SessionDB(db_path=home / "profiles" / run.profile / "state.db",
                                                       read_only=True)) as db:
                        assert db.get_session(worker_session)
                        assert db.get_session("private-unrelated-retry-thread") is None
        assert "DO-NOT-SHARE-RETRY-PRIVATE-HISTORY" not in json.dumps(calls)
        (tmp_path / "retry-acceptance-report.json").write_text(json.dumps({
            "recovered_task": recover, "exhausted_task": exhausted, "restart_witness_task": witness,
            "model_requests": len(calls), "synthetic_model": True, "production_activated": False,
            "checks": ["normal_gateway_dispatch", "second_attempt_recovered", "retry_limit_stopped_worker",
                       "exhaustion_survived_restart", "fresh_task_completed_after_restart",
                       "all_worker_histories_retained", "unrelated_history_not_shared"],
        }, indent=2), encoding="utf-8")
        print(f"EVIDENCE {tmp_path}", flush=True)
    finally:
        stop()
        model.shutdown()
        model.server_close()
        serving.join(timeout=5)
        log.close()
        assert not serving.is_alive()
