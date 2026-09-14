"""Actual pinned backend transport/restart check; synthetic home and local model only."""
import contextlib
import json
from pathlib import Path
import secrets
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

import psutil
import pytest
from websockets.sync.client import connect
from websockets.exceptions import InvalidStatus


def eventually(predicate, timeout=45):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.1)
    raise AssertionError("Timed out waiting for synthetic runtime checkpoint")


class Model(BaseHTTPRequestHandler):
    entered = threading.Event()
    release = threading.Event()
    held = False
    calls = []

    def log_message(self, *args):
        pass

    def do_GET(self):
        body = json.dumps({"data": [{"id": "mock-model", "object": "model"}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path != "/v1/chat/completions":
            self.send_error(404)
            return
        serialized = json.dumps(body.get("messages", []))
        type(self).calls.append(serialized)
        if "ORGO-CRASH-PROBE" in serialized and not type(self).held:
            type(self).held = True
            type(self).entered.set()
            type(self).release.wait(60)
        reply = "SYNTHETIC OPERATOR ACKNOWLEDGED"
        common = {"id": "mock-completion", "created": int(time.time()), "model": "mock-model"}
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream" if body.get("stream") else "application/json")
        self.end_headers()
        try:
            if body.get("stream"):
                for delta, finish in [({"role": "assistant", "content": reply}, None), ({}, "stop")]:
                    chunk = dict(common, object="chat.completion.chunk", choices=[
                        {"index": 0, "delta": delta, "finish_reason": finish}])
                    self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
                self.wfile.write(b"data: [DONE]\n\n")
            else:
                self.wfile.write(json.dumps(dict(common, object="chat.completion", choices=[
                    {"index": 0, "message": {"role": "assistant", "content": reply}, "finish_reason": "stop"}],
                    usage={"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2})).encode())
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


class Peer:
    def __init__(self, socket):
        self.socket = socket
        self.frames = []
        self.counter = 0

    def wait(self, predicate, timeout=60):
        deadline = time.monotonic() + timeout
        while True:
            for index, frame in enumerate(self.frames):
                if predicate(frame):
                    return self.frames.pop(index)
            frame = self.socket.recv(timeout=max(0.01, deadline - time.monotonic()))
            self.frames.extend(json.loads(line) for line in frame.splitlines() if line)

    def rpc(self, method, **params):
        self.counter += 1
        rid = self.counter
        self.socket.send(json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}))
        frame = self.wait(lambda item: item.get("id") == rid)
        assert "error" not in frame, frame
        return frame["result"]

    def event(self, kind):
        return self.wait(lambda item: item.get("params", {}).get("type") == kind)["params"]


def assert_startup_cleanup_isolated(tmp_path, monkeypatch):
    preflight_home = tmp_path / "preflight-home"
    preflight_home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(preflight_home))
    monkeypatch.setenv("HERMES_DISABLE_LAZY_INSTALLS", "1")
    from hermes_cli import dashboard_procs
    from hermes_cli import gateway
    from gateway import status

    # Never boot a candidate whose startup sweep can touch foreign processes.
    # This preflight uses no real PIDs/signals and fails BEFORE any server starts.
    with (patch.object(dashboard_procs, "_scan_dashboard_processes", return_value=[
              (987654321, "hermes serve --host 127.0.0.1 --port 0")]),
          patch.object(dashboard_procs, "_process_ppid", return_value=1),
          patch.object(dashboard_procs, "_process_age_seconds", return_value=600, create=True),
          patch.object(psutil, "Process", side_effect=psutil.AccessDenied(987654321)),
          patch.object(psutil, "pid_exists", return_value=False),
          patch("os.kill") as signal):
        result = dashboard_procs._reap_orphaned_desktop_local_serves(
            lock_owned_pids_fn=lambda: set(), sleep_fn=lambda seconds: None)
        assert not signal.called and not result["matched"], "Unsafe cross-home startup cleanup; do not boot"

    with (patch.object(gateway, "supports_systemd_services", return_value=False),
          patch.object(gateway, "is_windows", return_value=False),
          patch.object(gateway, "find_gateway_pids", return_value=[987654321]),
          patch.object(gateway, "_get_service_pids", return_value=set(), create=True),
          patch.object(gateway, "_reaper_candidate_is_supervisor_owned", return_value=False, create=True),
          patch.object(status, "get_running_pid", return_value=None),
          patch.object(status, "_read_pid_record", return_value=None, create=True),
          patch.object(status, "_read_gateway_lock_record", return_value=None, create=True),
          patch.object(status, "_pid_exists", return_value=False),
          patch.object(status, "write_planned_stop_marker") as marker,
          patch.object(psutil, "Process", side_effect=psutil.AccessDenied(987654321)),
          patch("os.kill") as signal):
        reaped = gateway._reap_unsupervised_gateway_orphans()
        assert not reaped and not signal.called and not marker.called, "Unsafe cross-home gateway cleanup; do not boot"


def test_actual_backend_auth_chat_crash_recovery_and_reconnect(tmp_path, monkeypatch):
    assert_startup_cleanup_isolated(tmp_path, monkeypatch)
    from tui_gateway import notification_inbox as inbox

    runtime = Path.cwd()
    receipt = json.loads((runtime / "orgo-runtime-receipt.json").read_text(encoding="utf-8"))
    assert receipt["state"] == "dependencies_ready" and receipt["activated"] is False
    assert receipt["overlay_sha256"] == "1db09c638e7834eba5a471b1d3fff7e20ec560530b4ea0bafb8c26a011902ce8"
    hermes_home = tmp_path / "synthetic-home"
    hermes_home.mkdir()
    model = ThreadingHTTPServer(("127.0.0.1", 0), Model)
    threading.Thread(target=model.serve_forever, daemon=True).start()
    endpoint = f"http://127.0.0.1:{model.server_port}/v1"
    config = {
        "model": {"default": "mock-model", "provider": "mock"},
        "providers": {"mock": {"api": endpoint, "api_mode": "chat_completions",
                               "key_env": "MOCK_API_KEY", "models": {"mock-model": {}}, "context_length": 8192}},
        "auxiliary": {"title_generation": {"enabled": False}},
        "agent": {"max_turns": 3}, "toolsets": [],
        "security": {"allow_lazy_installs": False},
        "desktop": {"auto_continue": {"enabled": True, "freshness_minutes": 15, "max_attempts": 1}},
    }
    # JSON is valid YAML; no real config, credentials, profiles or histories copied.
    (hermes_home / "config.yaml").write_text(json.dumps(config), encoding="utf-8")
    (hermes_home / ".env").write_text("MOCK_API_KEY=synthetic-local-only\n", encoding="utf-8")
    token = secrets.token_urlsafe(32)
    env = {"PATH": f"{runtime / '.venv/bin'}:/usr/local/bin:/usr/bin:/bin",
           "LANG": "C.UTF-8", "PYTHONUTF8": "1", "HERMES_HOME": str(hermes_home),
           "HERMES_DESKTOP": "1", "HERMES_DASHBOARD_SESSION_TOKEN": token,
           "HERMES_DISABLE_LAZY_INSTALLS": "1",
           "MOCK_API_KEY": "synthetic-local-only"}
    process = None
    generation = 0
    logs = []
    started_at = time.monotonic()
    checkpoints = []

    def checkpoint(name):
        checkpoints.append({"name": name, "elapsed_seconds": round(time.monotonic() - started_at, 2)})
        print(f"CHECKPOINT {name}", flush=True)

    def start():
        nonlocal process, generation
        generation += 1
        ready = tmp_path / f"ready-{generation}.json"
        log = (tmp_path / f"backend-{generation}.log").open("w", encoding="utf-8")
        logs.append(log)
        process = subprocess.Popen([sys.executable, "-m", "hermes_cli.main", "serve",
                                    "--isolated", "--host", "127.0.0.1", "--port", "0"],
                                   cwd=runtime, env=dict(env, HERMES_DESKTOP_READY_FILE=str(ready)),
                                   stdout=log, stderr=subprocess.STDOUT)
        def bound():
            assert process.poll() is None, f"backend exited: see {log.name}"
            return json.loads(ready.read_text(encoding="utf-8"))["port"] if ready.exists() else None
        return eventually(bound)

    def stop(kill=False):
        if process is None or process.poll() is not None:
            return
        parent = psutil.Process(process.pid)
        children = parent.children(recursive=True)
        (process.kill if kill else process.terminate)()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)
        # Only descendants positively owned by this test process; never argv scans.
        for child in children:
            with contextlib.suppress(psutil.NoSuchProcess):
                child.terminate()
        _, alive = psutil.wait_procs(children, timeout=3)
        for child in alive:
            with contextlib.suppress(psutil.NoSuchProcess):
                child.kill()
        _, survivors = psutil.wait_procs(alive, timeout=3)
        assert not survivors, "A test-owned child survived cleanup"

    def open_peer(port):
        sock = connect(f"ws://127.0.0.1:{port}/api/ws?token={token}",
                       origin=f"http://127.0.0.1:{port}", open_timeout=10)
        peer = Peer(sock)
        peer.event("gateway.ready")
        return peer

    try:
        port = start()
        checkpoint("backend_bound")
        with pytest.raises(InvalidStatus):
            with connect(f"ws://127.0.0.1:{port}/api/ws?token=wrong-token",
                         origin=f"http://127.0.0.1:{port}", open_timeout=10):
                pass
        peer = open_peer(port)
        created = peer.rpc("session.create", source="desktop", cwd=str(hermes_home), title="Disposable runtime acceptance")
        sid, stored = created["session_id"], created["stored_session_id"]
        peer.rpc("prompt.submit", session_id=sid, text="Synthetic boot check. Say acknowledged.")
        complete = peer.event("message.complete")
        assert complete["payload"]["status"] == "complete", complete
        checkpoint("authenticated_chat_complete")

        assert inbox.stage(hermes_home, stored, "synthetic-passive-delivery", "Passive specialist update",
                           delivery_mode="notify", metadata={"worker": "observer", "kind": "completed"})
        passive = eventually(lambda: next((r for r in inbox.inspect(hermes_home, stored)
                                           if r["id"] == "synthetic-passive-delivery" and r["state"] == "finished"), None))
        assert passive["attempts"] == 0 and len(Model.calls) == 1
        notice = peer.wait(lambda f: "synthetic-passive-delivery" in
                           f.get("params", {}).get("payload", {}).get("display_metadata", {}).get("delivery_ids", []))
        assert notice["params"]["payload"]["kind"] == "task_delivery"
        from hermes_state import SessionDB
        with contextlib.closing(SessionDB(db_path=hermes_home / "state.db", read_only=True)) as db:
            notices = [m for m in db.get_messages(stored) if m.get("platform_message_id") == "kanban-notice:synthetic-passive-delivery"]
            assert len(notices) == 1 and notices[0]["display_kind"] == "kanban_notification"
        checkpoint("passive_notice_persisted_without_model_turn")

        # Exercise the actual board poller, not just manually staged inbox
        # metadata. A later assignee must not redirect the worker's history.
        from hermes_cli import kanban_db as kb
        worker_home = hermes_home / "profiles" / "analyst"
        worker_home.mkdir(parents=True)
        worker_stored = "synthetic-worker-thread"
        with contextlib.closing(SessionDB(db_path=worker_home / "state.db")) as db:
            db.create_session(worker_stored, "desktop", model="mock-model", profile_name="analyst")
            db.append_message(worker_stored, "assistant", "SYNTHETIC WORKER RESULT: 161")
        with kb.connect_closing(hermes_home / "kanban.db") as board:
            task = kb.create_task(board, title="Synthetic worker navigation", assignee="analyst")
            kb.add_notify_sub(board, task_id=task, platform="tui", chat_id=stored, delivery_mode="notify")
            assert kb.complete_task(board, task, summary="Synthetic worker result: 161",
                                    metadata={"worker_session_id": worker_stored}, fire_lifecycle_hook=False)
            assert kb.assign_task(board, task, "reviewer")
        worker_notice = peer.wait(lambda frame: any(
            update.get("task_id") == task
            for update in frame.get("params", {}).get("payload", {}).get("display_metadata", {}).get("task_updates", [])
        ))
        worker_metadata = worker_notice["params"]["payload"]["display_metadata"]
        update = next(item for item in worker_metadata["task_updates"] if item.get("task_id") == task)
        assert update["worker"] == "analyst" and update["assignee"] == "reviewer"
        assert update["worker_session_id"] == worker_stored
        with contextlib.closing(SessionDB(db_path=hermes_home / "state.db", read_only=True)) as db:
            saved_notices = [m for m in db.get_messages(stored)
                             if m.get("platform_message_id") in {
                                 "kanban-notice:" + delivery_id for delivery_id in worker_metadata["delivery_ids"]}]
            assert len(saved_notices) == 1
            saved_metadata = saved_notices[0]["display_metadata"]
            if isinstance(saved_metadata, str):
                saved_metadata = json.loads(saved_metadata)
            assert saved_metadata["task_updates"][0]["worker_session_id"] == worker_stored
        assert len(Model.calls) == 1, "Passive worker link must not wake the operator"
        checkpoint("board_worker_link_attributed_and_persisted")

        assert inbox.stage(hermes_home, stored, "synthetic-crash-delivery", "ORGO-CRASH-PROBE: specialist result 161",
                           metadata={"task_id": "synthetic-task", "board": "synthetic-only", "worker": "analyst", "kind": "completed"})
        eventually(Model.entered.is_set)
        row = next(r for r in inbox.inspect(hermes_home, stored) if r["id"] == "synthetic-crash-delivery")
        assert row["state"] == "running" and row["attempts"] == 1, row
        delivery = peer.wait(lambda f: "synthetic-crash-delivery" in
                             f.get("params", {}).get("payload", {}).get("display_metadata", {}).get("delivery_ids", []))
        assert delivery["params"]["payload"]["display_metadata"]["task_updates"][0]["worker"] == "analyst"
        stop(kill=True)
        peer.socket.close()
        Model.release.set()
        checkpoint("process_killed_at_model_boundary")

        port = start()
        peer = open_peer(port)
        resumed = peer.rpc("session.resume", session_id=stored, cols=120)
        assert resumed["session_id"], resumed
        completed = eventually(lambda: next((r for r in inbox.inspect(hermes_home, stored)
                                             if r["id"] == "synthetic-crash-delivery" and r["state"] == "finished"), None), timeout=60)
        assert completed["outcome"] == "complete" and completed["attempts"] == 2, completed
        assert any("Recovering an interrupted task-result turn" in call for call in Model.calls)
        checkpoint("recovery_settled_after_one_retry")
        peer.socket.close()
        peer = open_peer(port)
        again = peer.rpc("session.resume", session_id=stored, cols=120)
        assert again["session_id"]
        assert not inbox.claim(hermes_home, stored)
        assert not inbox.inspect(tmp_path / "unrelated-home", stored)
        peer.socket.close()
        stop()

        # Seed a compression continuation only after the test-owned writer has
        # stopped. This exercises cold resume/routing, not model summarization.
        continuation = "synthetic-compression-continuation"
        with contextlib.closing(SessionDB(db_path=hermes_home / "state.db")) as db:
            db.end_session(stored, "compression")
            db.create_session(continuation, source="desktop", parent_session_id=stored)
        for identity, mode in [("synthetic-compressed-passive", "notify"),
                               ("synthetic-compressed-active", "notify+wake")]:
            assert inbox.stage(hermes_home, stored, identity, "Result from before compression: " + identity,
                               delivery_mode=mode, metadata={"worker": "analyst", "kind": "completed"})
        calls_before = len(Model.calls)
        port = start()
        peer = open_peer(port)
        peer.rpc("session.resume", session_id=stored, cols=120)

        def compressed_finished():
            rows = {r["id"]: r for r in inbox.inspect(hermes_home, stored)
                    if r["id"].startswith("synthetic-compressed-")}
            return rows if len(rows) == 2 and all(r["state"] == "finished" for r in rows.values()) else None

        compressed = eventually(compressed_finished, timeout=60)
        assert compressed["synthetic-compressed-passive"]["attempts"] == 0
        assert compressed["synthetic-compressed-active"]["attempts"] == 1
        assert len(Model.calls) == calls_before + 1
        assert not inbox.inspect(hermes_home, continuation), "Receipts must keep their original identities"
        with contextlib.closing(SessionDB(db_path=hermes_home / "state.db", read_only=True)) as db:
            assert db.get_compression_tip(stored) == continuation
            assert any(m.get("platform_message_id") == "kanban-notice:synthetic-compressed-passive"
                       for m in db.get_messages(continuation))
        peer.socket.close()
        checkpoint("cold_compression_resume_delivered_passive_and_active_once")
        report = {"receipt": receipt, "checkpoints": ["authenticated_chat", "wrong_token_denied",
                  "passive_notice_no_model", "crash_at_model_boundary", "recovered_once",
                  "settled_not_reclaimed", "reconnected", "seeded_compression_resume_delivery",
                  "board_worker_link_attributed_and_persisted"],
                  "delivery_attempts": completed["attempts"], "model_requests": len(Model.calls),
                  "production_activated": False}
    finally:
        Model.release.set()
        stop()
        model.shutdown()
        model.server_close()
        for log in logs:
            log.close()
    checkpoint("test_owned_processes_stopped")
    report["timing"] = checkpoints
    report["process_cleanup_verified"] = True
    (tmp_path / "acceptance-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"EVIDENCE {tmp_path}", flush=True)
