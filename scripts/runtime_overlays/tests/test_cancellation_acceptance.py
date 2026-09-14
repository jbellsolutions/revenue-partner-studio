"""Real authenticated backend + Hermes worker cancellation; loopback model only.

Run explicitly with scripts/run_tests.sh from the source/runtime checkout.
This is manual acceptance, not an ordinary CI test or production task.
"""

import contextlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import threading
import time
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import psutil

from test_runtime_acceptance import assert_startup_cleanup_isolated, eventually


def test_authenticated_cancellation_stops_real_hermes_worker_and_terminal(tmp_path, monkeypatch):
    assert_startup_cleanup_isolated(tmp_path, monkeypatch)
    from hermes_cli import kanban_db as kb
    from hermes_state import SessionDB

    runtime = Path.cwd()
    home = tmp_path / "synthetic-cancellation-home"
    profile_home = home / "profiles" / "synthetic-cancel-worker"
    profile_home.mkdir(parents=True)
    calls = []
    tool_requested = threading.Event()

    class Model(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if self.path != "/v1/chat/completions":
                self.send_error(404)
                return
            calls.append(body)
            results = [item for item in body.get("messages", []) if item.get("role") == "tool"]
            message = {"role": "assistant", "content": "Synthetic worker returned after terminal"}
            finish = "stop"
            if not results:
                message.update(content=None, tool_calls=[{
                    "id": "synthetic-sleep-tool", "type": "function",
                    "function": {"name": "terminal", "arguments": json.dumps({"command": "sleep 25", "timeout": 30})},
                }])
                finish = "tool_calls"
                tool_requested.set()
            common = {"id": "synthetic-cancel-model", "created": int(time.time()), "model": "mock-worker"}
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream" if body.get("stream") else "application/json")
            self.end_headers()
            try:
                if body.get("stream"):
                    delta = dict(message)
                    if finish == "tool_calls":
                        delta["tool_calls"] = [dict(message["tool_calls"][0], index=0)]
                    for chunk, reason in [(delta, None), ({}, finish)]:
                        self.wfile.write(("data: " + json.dumps(dict(common, object="chat.completion.chunk", choices=[{
                            "index": 0, "delta": chunk, "finish_reason": reason,
                        }])) + "\n\n").encode())
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
    config = {
        "model": {"default": "mock-worker", "provider": "mock"},
        "providers": {"mock": {"api": f"http://127.0.0.1:{model.server_port}/v1",
                               "api_mode": "chat_completions", "key_env": "MOCK_API_KEY",
                               "models": {"mock-worker": {}}, "context_length": 32768}},
        "toolsets": ["terminal", "kanban"], "terminal": {"backend": "local", "cwd": str(home)},
        "agent": {"max_turns": 3}, "compression": {"enabled": False}, "plugins": {"enabled": []},
        "security": {"allow_lazy_installs": False}, "auxiliary": {"title_generation": {"enabled": False}},
        "desktop": {"auto_continue": {"enabled": False}},
        "kanban": {"dispatch_in_gateway": False, "auto_subscribe_on_create": False},
    }
    for target in (home, profile_home):
        (target / "config.yaml").write_text(json.dumps(config), encoding="utf-8")
        (target / ".env").write_text("MOCK_API_KEY=synthetic-local-only\n", encoding="utf-8")
        (target / "SOUL.md").write_text("Synthetic cancellation acceptance only.", encoding="utf-8")
    with contextlib.closing(SessionDB(db_path=home / "state.db")) as db:
        db.create_session("private-unrelated-thread", "desktop")
        db.append_message("private-unrelated-thread", "user", "UNRELATED-PRIVATE-CANCELLATION-MARKER")
    token = secrets.token_urlsafe(32)
    env = {"PATH": f"{runtime / '.venv/bin'}:/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8",
           "PYTHONUTF8": "1", "HERMES_HOME": str(home), "HERMES_DESKTOP": "1",
           "HERMES_DASHBOARD_SESSION_TOKEN": token, "HERMES_DISABLE_LAZY_INSTALLS": "1",
           "MOCK_API_KEY": "synthetic-local-only"}
    process = None
    workers = []
    terminal_processes = []
    log = (tmp_path / "cancellation-backend.log").open("w", encoding="utf-8")
    serving.start()

    def live(owned):
        try:
            return owned.is_running() and owned.status() != psutil.STATUS_ZOMBIE
        except psutil.NoSuchProcess:
            return False

    def stop_owned(owned):
        captured = [owned]
        with contextlib.suppress(psutil.NoSuchProcess):
            captured.extend(owned.children(recursive=True))
        for child in reversed(captured):
            with contextlib.suppress(psutil.NoSuchProcess):
                child.terminate()
        _, alive = psutil.wait_procs(captured, timeout=3)
        for child in alive:
            with contextlib.suppress(psutil.NoSuchProcess):
                child.kill()
        psutil.wait_procs(alive, timeout=3)
        assert not any(live(child) for child in captured)

    try:
        ready = tmp_path / "cancellation-ready.json"
        process = subprocess.Popen([
            sys.executable, "-m", "hermes_cli.main", "serve", "--isolated", "--host", "127.0.0.1", "--port", "0",
        ], cwd=runtime, env=dict(env, HERMES_DESKTOP_READY_FILE=str(ready)), stdout=log, stderr=subprocess.STDOUT)

        def bound():
            assert process.poll() is None, f"Backend exited: see {log.name}"
            return json.loads(ready.read_text(encoding="utf-8"))["port"] if ready.exists() else None

        port = eventually(bound)

        def request(path, supplied_token=token, method="GET"):
            req = Request(f"http://127.0.0.1:{port}/api/plugins/kanban{path}",
                          data=b"{}" if method == "POST" else None, method=method,
                          headers={"X-Hermes-Session-Token": supplied_token, "Content-Type": "application/json",
                                   "Origin": f"http://127.0.0.1:{port}"})
            try:
                with urlopen(req, timeout=15) as response:
                    return response.status, json.loads(response.read())
            except HTTPError as exc:
                return exc.code, json.loads(exc.read())

        assert request("/board")[0] == 200
        with patch.dict(os.environ, env, clear=True):
            with kb.connect_closing() as board:
                db_path = kb.kanban_db_path()
                task_id = kb.create_task(board, title="Synthetic live cancellation", assignee="synthetic-cancel-worker",
                                         body="Run the harmless sleep command and wait.", max_runtime_seconds=60, max_retries=1)
                unrelated_id = kb.create_task(board, title="Unrelated parked task")
                assert kb.block_task(board, unrelated_id, reason="Synthetic task must stay parked")
                assert kb.get_task(board, unrelated_id).status == "blocked"
                kb.add_comment(board, task_id, "default", "Keep cancellation discussion")

                def spawn(task, workspace, *, board=None):
                    pid = kb._default_spawn(task, workspace, board=board)
                    assert pid
                    workers.append(psutil.Process(pid))
                    return pid

                kb.dispatch_once(board, spawn_fn=spawn, max_spawn=1, max_in_progress=1, reconcile_orphans=False)
                assert len(workers) == 1
                run_id = kb.get_task(board, task_id).current_run_id

        def terminal_started():
            assert live(workers[0]), "Worker exited before cancellation"
            for child in workers[0].children(recursive=True):
                with contextlib.suppress(psutil.NoSuchProcess):
                    argv = child.cmdline()
                    if argv and Path(argv[0]).name == "sleep" and argv[-1] == "25":
                        terminal_processes.append(child)
                        return True
            return False

        eventually(terminal_started, timeout=30)
        assert tool_requested.is_set()
        print("CHECKPOINT real_hermes_worker_executing_sleep", flush=True)
        for invalid in ("", "wrong-synthetic-token"):
            assert request(f"/tasks/{task_id}/cancel", invalid, "POST")[0] == 401
            assert live(workers[0]) and live(terminal_processes[0])
        assert request(f"/tasks/{task_id}")[1]["task"]["status"] == "running"
        status, result = request(f"/tasks/{task_id}/cancel", method="POST")
        assert status == 200 and result["worker_stopped"] and result["ok"], result
        assert not live(workers[0]) and not live(terminal_processes[0]), "Success must precede test cleanup"
        assert process.poll() is None, "Cancellation must not stop the backend"
        assert request(f"/tasks/{task_id}/cancel", method="POST")[1]["worker_stopped"]
        print("CHECKPOINT authenticated_cancel_stopped_real_worker_and_terminal", flush=True)

        # Restart only this disposable backend. The cancelled state, transcript
        # and cleanup verdict must survive a new process, not just a warm cache.
        stop_owned(psutil.Process(process.pid))
        process.wait(timeout=5)
        ready = tmp_path / "cancellation-restart-ready.json"
        process = subprocess.Popen([
            sys.executable, "-m", "hermes_cli.main", "serve", "--isolated", "--host", "127.0.0.1", "--port", "0",
        ], cwd=runtime, env=dict(env, HERMES_DESKTOP_READY_FILE=str(ready)), stdout=log, stderr=subprocess.STDOUT)
        port = eventually(bound)
        resumed_detail = request(f"/tasks/{task_id}")[1]
        resumed = resumed_detail["task"]
        assert resumed["status"] == "cancelled" and resumed["cancellation_pending"] is False
        print("CHECKPOINT cancellation_survived_backend_restart", flush=True)
        with kb.connect_closing(db_path) as board:
            task = kb.get_task(board, task_id)
            assert task.status == "cancelled" and task.worker_pid is None
            assert kb.get_task(board, unrelated_id).status == "blocked"
            assert not kb.complete_task(board, task_id, summary="Late completion", expected_run_id=run_id)
            assert kb.list_comments(board, task_id)[0].body == "Keep cancellation discussion"
            assert kb.list_runs(board, task_id)[0].outcome == "cancelled"
            with patch.dict(os.environ, env, clear=True):
                retry = kb.dispatch_once(board, spawn_fn=lambda *a, **kw: (_ for _ in ()).throw(AssertionError("Cancelled work respawned")),
                                         reconcile_orphans=False)
                assert not retry.spawned
        assert "UNRELATED-PRIVATE-CANCELLATION-MARKER" not in json.dumps(calls)
        with contextlib.closing(SessionDB(db_path=home / "state.db", read_only=True)) as db:
            assert db.get_messages("private-unrelated-thread")[0]["content"] == "UNRELATED-PRIVATE-CANCELLATION-MARKER"
        with contextlib.closing(SessionDB(db_path=profile_home / "state.db", read_only=True)) as db:
            sessions = db.list_sessions_rich(source="kanban")
            assert len(sessions) == 1
            worker_session = sessions[0]["id"]
            assert db.get_messages(worker_session), "Cancellation must preserve the worker conversation"
            assert db.get_session("private-unrelated-thread") is None
        with kb.connect_closing(db_path) as board:
            run = kb.get_run(board, run_id)
            assert run.profile == "synthetic-cancel-worker"
            assert run.metadata and run.metadata["worker_session_id"] == worker_session
        wire_run = next(item for item in resumed_detail["runs"] if item["id"] == run_id)
        assert wire_run["profile"] == "synthetic-cancel-worker"
        assert wire_run["metadata"]["worker_session_id"] == worker_session
        (tmp_path / "cancellation-acceptance-report.json").write_text(json.dumps({
            "task_id": task_id, "run_id": run_id, "worker_session": worker_session, "model_requests": len(calls),
            "synthetic_model": True, "production_activated": False,
            "checks": ["real_worker_and_terminal_started", "missing_and_wrong_tokens_denied",
                       "worker_and_terminal_stopped_before_test_cleanup", "backend_survived", "history_preserved",
                       "late_completion_rejected", "no_respawn", "unrelated_task_and_history_preserved",
                       "cancelled_state_survived_backend_restart", "worker_conversation_preserved_in_own_profile",
                       "cancelled_run_links_exact_worker_conversation", "authenticated_rest_exposes_exact_worker_link"],
        }, indent=2), encoding="utf-8")
        print(f"EVIDENCE {tmp_path}", flush=True)
    finally:
        for owned in [*terminal_processes, *workers]:
            stop_owned(owned)
        if process and process.poll() is None:
            stop_owned(psutil.Process(process.pid))
        if process:
            process.wait(timeout=5)
        model.shutdown()
        model.server_close()
        serving.join(timeout=5)
        log.close()
        assert not serving.is_alive()
