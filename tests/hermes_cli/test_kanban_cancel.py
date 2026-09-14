"""Cancellation must stop only its own worker and never become an automatic retry."""

import os
import subprocess
import sys

import psutil
import pytest

from hermes_cli import kanban_db as kb


@pytest.fixture
def board(tmp_path, monkeypatch):
    from hermes_cli.profiles import get_profile_dir

    # Dispatch deliberately refuses nonexistent profiles. Create a real,
    # isolated profile instead of bypassing that production admission check.
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes-home"))
    get_profile_dir("worker").mkdir(parents=True)
    with kb.connect_closing(tmp_path / "cancel-board.db") as conn:
        yield conn


def test_cancel_pending_is_durable_idempotent_and_does_not_release_dependents(board):
    parent = kb.create_task(board, title="Cancel before dispatch", assignee="worker")
    child = kb.create_task(board, title="Wait for parent", assignee="worker", parents=[parent])
    first = kb.cancel_task(board, parent, reason="User stopped this task")
    assert first["ok"] and first["worker_stopped"]
    assert kb.get_task(board, parent).status == "cancelled"
    assert kb.cancel_task(board, parent)["ok"]
    assert board.execute("SELECT count(*) FROM task_events WHERE task_id=? AND kind='cancelled'", (parent,)).fetchone()[0] == 1
    kb.recompute_ready(board)
    assert kb.get_task(board, child).status == "todo"
    assert not kb.complete_task(board, parent, summary="Late success")
    spawned = []
    kb.dispatch_once(board, spawn_fn=lambda *args, **kwargs: spawned.append(args), reconcile_orphans=False)
    assert not spawned


@pytest.mark.parametrize("matching_identity", [True, False])
def test_cancel_checks_worker_identity_before_signalling(board, tmp_path, matching_identity):
    task_id = kb.create_task(board, title="Synthetic running task", assignee="worker")
    children = []

    def spawn(task, workspace, **kwargs):
        env = dict(os.environ, HERMES_KANBAN_TASK=task.id if matching_identity else "another-task",
                   HERMES_KANBAN_CLAIM_LOCK=task.claim_lock, HERMES_KANBAN_DB=str(tmp_path / "cancel-board.db"))
        proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], env=env)
        children.append(proc)
        return proc.pid

    try:
        kb.dispatch_once(board, spawn_fn=spawn, max_spawn=1, reconcile_orphans=False)
        assert len(children) == 1
        proc = children[0]
        before = kb.get_task(board, task_id)
        result = kb.cancel_task(board, task_id, reason="Synthetic cancellation")
        assert kb.get_task(board, task_id).status == "cancelled"
        if matching_identity:
            proc.wait(timeout=5)
            assert result["ok"] and result["worker_stopped"]
            assert kb.get_task(board, task_id).worker_pid is None
        else:
            assert not result["ok"] and not result["worker_stopped"]
            assert proc.poll() is None, "Never signal a PID whose task identity differs"
            assert kb.get_task(board, task_id).worker_pid == proc.pid
            assert not kb.archive_task(board, task_id)
            assert not kb.delete_task(board, task_id)
            assert not kb.reclaim_task(board, task_id)
            from plugins.kanban.dashboard.plugin_api import _set_status_direct
            for status in ("ready", "todo", "triage"):
                assert not _set_status_direct(board, task_id, status)
            assert proc.poll() is None
        runs = kb.list_runs(board, task_id)
        assert len(runs) == 1 and runs[0].outcome == "cancelled"
        assert not kb.complete_task(board, task_id, summary="Late result", expected_run_id=before.current_run_id)
        spawned_again = []
        kb.dispatch_once(board, spawn_fn=lambda *args, **kwargs: spawned_again.append(args), reconcile_orphans=False)
        assert not spawned_again
    finally:
        for proc in children:
            if proc.poll() is None:
                proc.terminate()
            proc.wait(timeout=5)


def test_cancellation_does_not_rewrite_completed_history(board):
    task_id = kb.create_task(board, title="Already finished", assignee="worker")
    assert kb.complete_task(board, task_id, summary="Keep this result")
    with pytest.raises(ValueError, match="already"):
        kb.cancel_task(board, task_id)
    assert kb.get_task(board, task_id).status == "done"
    assert kb.latest_summary(board, task_id) == "Keep this result"
    assert kb.cancel_task(board, "missing-task") is None


def test_cancel_refuses_uncommitted_outer_transaction(board):
    task_id = kb.create_task(board, title="Transaction guard", assignee="worker")
    board.execute("BEGIN")
    try:
        with pytest.raises(RuntimeError, match="transaction"):
            kb.cancel_task(board, task_id)
    finally:
        board.rollback()
    assert kb.get_task(board, task_id).status != "cancelled"


def test_cancellation_during_spawn_stops_late_worker(board, tmp_path):
    task_id = kb.create_task(board, title="Cancel startup race", assignee="worker")
    children = []

    def spawn(task, workspace, **kwargs):
        cancelled = kb.cancel_task(board, task.id)
        assert not cancelled["worker_stopped"], "A claim with no recorded PID may still be starting"
        assert cancelled["termination"]["reason"] == "worker_start_pending"
        env = dict(os.environ, HERMES_KANBAN_TASK=task.id,
                   HERMES_KANBAN_CLAIM_LOCK=task.claim_lock,
                   HERMES_KANBAN_DB=str(tmp_path / "cancel-board.db"))
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], env=env)
        children.append(child)
        return child.pid

    try:
        kb.dispatch_once(board, spawn_fn=spawn, max_spawn=1, reconcile_orphans=False)
        assert len(children) == 1
        children[0].wait(timeout=5)
        task = kb.get_task(board, task_id)
        assert task.status == "cancelled" and task.worker_pid is None and task.claim_lock is None
        kb._record_spawn_failure(board, task_id, "Late spawn failure", failure_limit=1)
        assert kb.get_task(board, task_id).status == "cancelled"
        assert len(kb.list_runs(board, task_id)) == 1
    finally:
        for child in children:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=5)


@pytest.mark.parametrize("boundary", ["reused_pid", "another_host", "another_boot"])
def test_cleanup_receipts_never_authorize_a_different_process_or_machine(board, monkeypatch, boundary):
    from hermes_cli import kanban_cancellation as cancellation

    task_id = kb.create_task(board, title="Saved identity boundary", assignee="worker")
    assert kb.cancel_task(board, task_id)["ok"]
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    try:
        identity = psutil.Process(child.pid)
        with kb.write_txn(board):
            board.execute("UPDATE tasks SET worker_pid=?, claim_lock='synthetic-claim' WHERE id=?", (child.pid, task_id))
        created = identity.create_time() + (1 if boundary == "reused_pid" else 0)
        cancellation._save_targets(board, task_id, {(child.pid, created)})
        with monkeypatch.context() as changed:
            if boundary == "another_host":
                changed.setattr(cancellation.socket, "gethostname", lambda: "unrelated-synthetic-host")
            elif boundary == "another_boot":
                boot_time = psutil.boot_time()
                changed.setattr(psutil, "boot_time", lambda: boot_time + 10)
            result = kb.cancel_task(board, task_id)
        assert child.poll() is None, "Saved PID alone must never authorize a signal"
        assert result["worker_stopped"] == (boundary == "reused_pid")
    finally:
        if child.poll() is None:
            child.kill()
        child.wait(timeout=5)


def test_cancel_refuses_to_kill_its_own_controller(board):
    from hermes_cli import kanban_cancellation as cancellation

    task_id = kb.create_task(board, title="Controller is inside task", assignee="worker")
    assert kb.cancel_task(board, task_id)["ok"]
    controller = psutil.Process()
    with kb.write_txn(board):
        board.execute("UPDATE tasks SET worker_pid=?, claim_lock='synthetic-claim' WHERE id=?", (controller.pid, task_id))
    cancellation._save_targets(board, task_id, {(controller.pid, controller.create_time())})
    result = kb.cancel_task(board, task_id)
    assert not result["worker_stopped"]
    assert result["termination"]["reason"] == "cancellation_requires_external_controller"


def test_board_keeps_cancelled_tasks_out_of_the_todo_fallback(board, tmp_path, monkeypatch):
    from plugins.kanban.dashboard import plugin_api

    task_id = kb.create_task(board, title="Cancelled task remains visible", assignee="worker")
    assert kb.cancel_task(board, task_id)["ok"]
    monkeypatch.setenv("HERMES_KANBAN_DB", str(tmp_path / "cancel-board.db"))
    result = plugin_api.get_board(tenant=None, include_archived=False, board=None,
                                  workflow_template_id=None, current_step_key=None)
    columns = {column["name"]: column["tasks"] for column in result["columns"]}
    assert any(task["id"] == task_id and task["status"] == "cancelled" for task in columns["cancelled"])
    assert not any(task["id"] == task_id for task in columns["todo"])


@pytest.mark.live_system_guard_bypass
def test_cancel_retry_retains_descendant_after_parent_exits(board, tmp_path, monkeypatch):
    # The ordinary parent-tree guard cannot recognize an orphan after its
    # parent exits. Replace it here with a stricter captured-identity allowlist.
    task_id = kb.create_task(board, title="Keep cleanup ownership", assignee="worker")
    roots = []
    descendants = []
    owned_identities = []
    real_kill = os.kill

    def owned_kill(pid, sig):
        if sig:
            assert psutil.Process(pid) in owned_identities, "Refuse signals outside this test's captured processes"
        return real_kill(pid, sig)

    monkeypatch.setattr(os, "kill", owned_kill)

    def spawn(task, workspace, **kwargs):
        env = dict(os.environ, HERMES_KANBAN_TASK=task.id,
                   HERMES_KANBAN_CLAIM_LOCK=task.claim_lock,
                   HERMES_KANBAN_DB=str(tmp_path / "cancel-board.db"))
        source = (
            "import subprocess, sys, time; "
            "p=subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], "
            "stdout=subprocess.DEVNULL); print(p.pid, flush=True); time.sleep(60)"
        )
        root = subprocess.Popen([sys.executable, "-u", "-c", source], env=env,
                                stdout=subprocess.PIPE, text=True, encoding="utf-8")
        roots.append(root)
        descendants.append(psutil.Process(int(root.stdout.readline())))
        owned_identities.extend([psutil.Process(root.pid), descendants[0]])
        return root.pid

    terminate, kill, wait = psutil.Process.terminate, psutil.Process.kill, psutil.wait_procs

    def deny_child(method):
        def signal(process):
            if process == descendants[0]:
                raise psutil.AccessDenied(process.pid)
            return method(process)
        return signal

    try:
        kb.dispatch_once(board, spawn_fn=spawn, max_spawn=1, reconcile_orphans=False)
        assert len(roots) == len(descendants) == 1
        with monkeypatch.context() as denied:
            denied.setattr(psutil.Process, "terminate", deny_child(terminate))
            denied.setattr(psutil.Process, "kill", deny_child(kill))
            denied.setattr(psutil, "wait_procs", lambda procs, timeout: wait(procs, timeout=0.05))
            result = kb.cancel_task(board, task_id)
            assert not result["worker_stopped"]
        roots[0].wait(timeout=5)
        assert descendants[0].is_running()
        retry = kb.cancel_task(board, task_id)
        assert retry["worker_stopped"]
        assert not descendants[0].is_running() or descendants[0].status() == psutil.STATUS_ZOMBIE
        assert kb.get_task(board, task_id).worker_pid is None
    finally:
        for process in descendants:
            try:
                process.kill()
                process.wait(timeout=5)
            except (psutil.NoSuchProcess, psutil.TimeoutExpired):
                pass
        for root in roots:
            if root.poll() is None:
                root.kill()
            root.wait(timeout=5)
            root.stdout.close()
