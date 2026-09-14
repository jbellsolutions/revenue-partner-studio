"""Authenticated Desktop create/delegate/return acceptance, using local models only.

Run explicitly with scripts/run_tests.sh from the runtime checkout to validate.
Unlike the pinned overlay test, this also supports the source checkout itself.
The gateway-loop case uses the normal background scheduler, with no messaging
platforms enabled and no manual dispatch; both cases keep separate temp homes.
"""

import contextlib
import json
import os
from pathlib import Path
import secrets
import shlex
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

import psutil
import pytest
from websockets.sync.client import connect

from test_runtime_acceptance import Peer, assert_startup_cleanup_isolated, eventually


@pytest.mark.parametrize("dispatch_mode", ["single-pass", "gateway-loop"])
def test_authenticated_operator_creates_delegates_and_receives_worker_result(tmp_path, monkeypatch, dispatch_mode):
    assert_startup_cleanup_isolated(tmp_path, monkeypatch)
    from hermes_cli import kanban_db as kb
    from hermes_state import SessionDB

    runtime = Path.cwd()
    home = tmp_path / "synthetic-team-home"
    home.mkdir()
    specialist = "synthetic-arithmetic"
    calls = []
    failed_steps = []
    worker_entered = threading.Event()
    release_worker = threading.Event()
    create_command = shlex.join([
        sys.executable, "-m", "hermes_cli.main", "profile", "create", specialist,
        "--clone-from", "default", "--no-alias", "--description", "Synthetic arithmetic specialist",
    ])
    compute_command = shlex.join(["expr", "17", "*", "19"])

    class TeamModel(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if self.path != "/v1/chat/completions":
                self.send_error(404)
                return
            calls.append(body)
            messages = body.get("messages", [])
            results = [m for m in messages if m.get("role") == "tool"]
            serialized = json.dumps(messages)
            tool = None
            args = None
            if body["model"] == "mock-worker":
                if not results:
                    worker_entered.set()
                    if dispatch_mode == "gateway-loop" and not release_worker.wait(60):
                        failed_steps.append("Test did not capture the scheduled worker before timeout")
                        self.send_error(503)
                        return
                    tool, args = "terminal", {"command": compute_command, "timeout": 20}
                elif len(results) == 1:
                    computation = json.loads(results[0]["content"])
                    if computation.get("exit_code") == 0 and computation.get("output", "").strip() == "323":
                        tool, args = "kanban_complete", {"summary": "SYNTHETIC TEAM RESULT: 323"}
                    else:
                        failed_steps.append(computation)
                        reply = "SYNTHETIC WORKER BLOCKED: calculation did not succeed"
                else:
                    reply = "SYNTHETIC WORKER FINISHED"
            elif "SYNTHETIC TEAM RESULT: 323" in serialized:
                reply = "OPERATOR RECEIVED TEAM RESULT: 323"
            elif not results:
                tool, args = "terminal", {"command": create_command, "workdir": str(runtime), "timeout": 30}
            elif len(results) == 1:
                creation = json.loads(results[0]["content"])
                if creation.get("exit_code") == 0:
                    tool, args = "kanban_create", {
                        "title": "Synthetic arithmetic acceptance", "body": "Compute 17 * 19 and report the result.",
                        "assignee": specialist, "model": "mock-worker", "provider": "mock",
                        "idempotency_key": "synthetic-team-acceptance", "max_runtime_seconds": 60, "max_retries": 1,
                    }
                else:
                    failed_steps.append(creation)
                    reply = "SYNTHETIC OPERATOR BLOCKED: creation did not succeed"
            else:
                reply = "SYNTHETIC TASK DELEGATED"
            message = {"role": "assistant", "content": None if tool else reply}
            if tool:
                message["tool_calls"] = [{"id": f"synthetic-call-{len(calls)}", "type": "function",
                                           "function": {"name": tool, "arguments": json.dumps(args)}}]
            finish = "tool_calls" if tool else "stop"
            common = {"id": f"synthetic-{len(calls)}", "created": int(time.time()), "model": body["model"]}
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream" if body.get("stream") else "application/json")
            self.end_headers()
            if body.get("stream"):
                delta = dict(message)
                if tool:
                    delta["tool_calls"] = [dict(call, index=n) for n, call in enumerate(delta["tool_calls"])]
                for chunk, reason in [(delta, None), ({}, finish)]:
                    event = dict(common, object="chat.completion.chunk",
                                 choices=[{"index": 0, "delta": chunk, "finish_reason": reason}])
                    self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
                self.wfile.write(b"data: [DONE]\n\n")
            else:
                self.wfile.write(json.dumps(dict(common, object="chat.completion", choices=[{
                    "index": 0, "message": message, "finish_reason": finish,
                }], usage={"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2})).encode())
            self.wfile.flush()

    model = ThreadingHTTPServer(("127.0.0.1", 0), TeamModel)
    serving = threading.Thread(target=model.serve_forever, daemon=True)
    endpoint = f"http://127.0.0.1:{model.server_port}/v1"
    config = {
        "model": {"default": "mock-operator", "provider": "mock"},
        "providers": {"mock": {"api": endpoint, "api_mode": "chat_completions", "key_env": "MOCK_API_KEY",
                               "models": {"mock-operator": {}, "mock-worker": {}}, "context_length": 32768}},
        "toolsets": ["terminal", "kanban"], "terminal": {"backend": "local", "cwd": str(home)},
        "agent": {"max_turns": 5}, "compression": {"enabled": False}, "plugins": {"enabled": []},
        "security": {"allow_lazy_installs": False}, "auxiliary": {"title_generation": {"enabled": False}},
        "desktop": {"auto_continue": {"enabled": True, "max_attempts": 1}},
        "kanban": {"auto_subscribe_on_create": True, "dispatch_in_gateway": dispatch_mode == "gateway-loop",
                   "dispatch_interval_seconds": 1, "max_spawn": 1, "max_in_progress": 1, "failure_limit": 1},
    }
    (home / "config.yaml").write_text(json.dumps(config), encoding="utf-8")
    (home / ".env").write_text("MOCK_API_KEY=synthetic-local-only\n", encoding="utf-8")
    (home / "SOUL.md").write_text("Synthetic local team acceptance only.", encoding="utf-8")
    with contextlib.closing(SessionDB(db_path=home / "state.db")) as db:
        db.create_session("unrelated-private-thread", "desktop")
        db.append_message("unrelated-private-thread", "user", "DO-NOT-SHARE-UNRELATED-HISTORY")
    token = secrets.token_urlsafe(32)
    env = {"PATH": f"{runtime / '.venv/bin'}:/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8",
           "PYTHONUTF8": "1", "HERMES_HOME": str(home), "HERMES_DESKTOP": "1",
           "HERMES_DASHBOARD_SESSION_TOKEN": token, "HERMES_DISABLE_LAZY_INSTALLS": "1",
           "MOCK_API_KEY": "synthetic-local-only"}
    process = None
    scheduler = None
    workers = []
    peer = None
    log = (tmp_path / "team-backend.log").open("w", encoding="utf-8")
    scheduler_log = (tmp_path / "team-scheduler.log").open("w", encoding="utf-8")
    serving.start()

    def spawn(task, workspace, *, board=None):
        pid = kb._default_spawn(task, workspace, board=board)
        if pid:
            with contextlib.suppress(psutil.NoSuchProcess):
                workers.append(psutil.Process(pid))
        return pid

    def stop_owned(owned):
        descendants = []
        with contextlib.suppress(psutil.NoSuchProcess):
            descendants = owned.children(recursive=True)
            owned.terminate()
        for child in descendants:
            with contextlib.suppress(psutil.NoSuchProcess):
                child.terminate()
        _, alive = psutil.wait_procs([owned, *descendants], timeout=5)
        for child in alive:
            with contextlib.suppress(psutil.NoSuchProcess):
                child.kill()
        _, survivors = psutil.wait_procs(alive, timeout=3)
        assert not survivors, "Test-owned process survived cleanup"

    try:
        ready = tmp_path / "team-ready.json"
        process = subprocess.Popen([
            sys.executable, "-m", "hermes_cli.main", "serve", "--isolated", "--host", "127.0.0.1", "--port", "0",
        ], cwd=runtime, env=dict(env, HERMES_DESKTOP_READY_FILE=str(ready)), stdout=log, stderr=subprocess.STDOUT)

        def bound():
            assert process.poll() is None, f"Backend exited: see {log.name}"
            return json.loads(ready.read_text(encoding="utf-8"))["port"] if ready.exists() else None

        port = eventually(bound)
        peer = Peer(connect(f"ws://127.0.0.1:{port}/api/ws?token={token}", origin=f"http://127.0.0.1:{port}"))
        peer.event("gateway.ready")
        created = peer.rpc("session.create", source="desktop", cwd=str(home), title="Synthetic team operator")
        sid, stored = created["session_id"], created["stored_session_id"]
        peer.rpc("prompt.submit", session_id=sid, text="Create an arithmetic specialist and delegate 17 * 19.")
        assert peer.event("message.complete")["payload"]["status"] == "complete"
        assert not failed_steps, failed_steps
        print("CHECKPOINT operator_created_specialist_and_delegated", flush=True)

        with patch.dict(os.environ, env, clear=True):
            with kb.connect_closing(home / "kanban.db") as board:
                tasks = kb.list_tasks(board)
                assert len(tasks) == 1
                task = tasks[0]
                assert task.assignee == specialist and task.session_id == stored
                subs = kb.list_notify_subs(board, task.id)
                assert any(s["chat_id"] == stored and s["delivery_mode"] == "notify+wake" for s in subs)
                if dispatch_mode == "single-pass":
                    dispatched = kb.dispatch_once(board, spawn_fn=spawn, max_spawn=1, failure_limit=1,
                                                  max_in_progress=1, reconcile_orphans=False)
                    assert workers, dispatched
        if dispatch_mode == "gateway-loop":
            # The normal gateway owns the periodic dispatcher. No tick, spawn,
            # notification, or completion hook is replaced by this test.
            scheduler_env = dict(env)
            scheduler_env.pop("HERMES_DESKTOP")
            scheduler_env.pop("HERMES_DASHBOARD_SESSION_TOKEN")
            scheduler = subprocess.Popen([
                sys.executable, "-m", "gateway.run",
            ], cwd=runtime, env=scheduler_env, stdout=scheduler_log, stderr=subprocess.STDOUT)

            def scheduled_worker():
                assert scheduler.poll() is None, f"Gateway exited: see {scheduler_log.name}"
                if not worker_entered.is_set():
                    return None
                with kb.connect_closing(home / "kanban.db") as board:
                    running = kb.get_task(board, task.id)
                    if running.worker_pid:
                        worker = psutil.Process(running.worker_pid)
                        assert worker.ppid() == scheduler.pid
                        assert Path(worker.environ()["HERMES_HOME"]).resolve() == (home / "profiles" / specialist).resolve()
                        return worker
                return None

            workers.append(eventually(scheduled_worker, timeout=60))
            release_worker.set()
        print("CHECKPOINT real_specialist_worker_spawned", flush=True)

        def received():
            assert not failed_steps, failed_steps
            with contextlib.closing(SessionDB(db_path=home / "state.db", read_only=True)) as db:
                return any(m.get("content") == "OPERATOR RECEIVED TEAM RESULT: 323" for m in db.get_messages(stored))

        eventually(received, timeout=90)
        assert len(workers) == 1
        if dispatch_mode == "single-pass":
            assert workers[0].wait(timeout=15) == 0, "Specialist must finish normally, not be stopped by test cleanup"
        else:
            def worker_exited():
                try:
                    return not workers[0].is_running() or workers[0].status() == psutil.STATUS_ZOMBIE
                except psutil.NoSuchProcess:
                    return True
            eventually(worker_exited, timeout=15)
            assert scheduler.poll() is None, "Scheduler must remain live after worker completion"
        with kb.connect_closing(home / "kanban.db") as board:
            finished = kb.get_task(board, task.id)
            assert finished.status == "done"
            runs = kb.list_runs(board, task.id)
            assert len(runs) == 1 and runs[0].status == "done"
            worker_stored = runs[0].metadata["worker_session_id"]
        with contextlib.closing(SessionDB(db_path=home / "profiles" / specialist / "state.db", read_only=True)) as db:
            assert db.get_session(worker_stored)
            assert db.get_session(stored) is None
            assert db.get_session("unrelated-private-thread") is None
            assert any(m.get("content") == "SYNTHETIC WORKER FINISHED" for m in db.get_messages(worker_stored))
        with contextlib.closing(SessionDB(db_path=home / "state.db", read_only=True)) as db:
            messages = db.get_messages(stored)
            notices = [m for m in messages if m.get("display_kind") == "kanban_notification"]
            updates = []
            for notice in notices:
                metadata = notice["display_metadata"]
                if isinstance(metadata, str):
                    metadata = json.loads(metadata)
                updates.extend(metadata.get("task_updates", []))
            assert any(u.get("task_id") == task.id and u.get("worker") == specialist
                       and u.get("worker_session_id") == worker_stored for u in updates)
            assert sum(m.get("content") == "OPERATOR RECEIVED TEAM RESULT: 323" for m in messages) == 1
            assert db.get_session(worker_stored) is None
        assert "DO-NOT-SHARE-UNRELATED-HISTORY" not in json.dumps(calls)
        worker_results = [json.loads(m["content"]) for c in calls if c["model"] == "mock-worker"
                          for m in c["messages"] if m.get("role") == "tool"]
        assert any(r.get("exit_code") == 0 and r.get("output", "").strip() == "323" for r in worker_results)
        print("CHECKPOINT worker_result_returned_without_second_user_prompt", flush=True)
        (tmp_path / "team-acceptance-report.json").write_text(json.dumps({
            "operator_session": stored, "worker_session": worker_stored, "task_id": task.id,
            "model_requests": len(calls), "synthetic_model": True, "production_activated": False,
            "dispatch_mode": dispatch_mode,
            "checks": ["profile_created", "task_assigned", "return_route_subscribed", "real_worker_spawned",
                       "worker_completed", "operator_woken", "separate_histories", "unrelated_history_not_shared"],
        }, indent=2), encoding="utf-8")
        print(f"EVIDENCE {tmp_path}", flush=True)
    finally:
        release_worker.set()
        if peer:
            peer.socket.close()
        if scheduler and scheduler.poll() is None:
            stop_owned(psutil.Process(scheduler.pid))
        if scheduler:
            scheduler.wait(timeout=5)
        for worker in workers:
            stop_owned(worker)
        if process and process.poll() is None:
            stop_owned(psutil.Process(process.pid))
        if process:
            process.wait(timeout=5)
        model.shutdown()
        model.server_close()
        serving.join(timeout=5)
        log.close()
        scheduler_log.close()
        assert not serving.is_alive()
