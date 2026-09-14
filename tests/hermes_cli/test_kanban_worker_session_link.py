"""Worker history belongs to the claimed attempt, including interrupted runs."""

import json

import pytest

from agent.delegation_context import delegated_child_context, non_dispatcher_owned_context
from hermes_cli import kanban_db as kb
from hermes_cli.profiles import get_profile_dir


@pytest.fixture
def worker(tmp_path, monkeypatch):
    home = tmp_path / "hermes-home"
    monkeypatch.setenv("HERMES_HOME", str(home))
    profile = get_profile_dir("worker")
    profile.mkdir(parents=True)
    path = tmp_path / "board.db"
    with kb.connect_closing(path) as conn:
        task_id = kb.create_task(conn, title="Keep worker history", assignee="worker")
        task = kb.claim_task(conn, task_id)
        for name, value in {
            "HERMES_HOME": profile, "HERMES_KANBAN_TASK": task_id,
            "HERMES_KANBAN_DB": path, "HERMES_KANBAN_RUN_ID": task.current_run_id,
            "HERMES_KANBAN_CLAIM_LOCK": task.claim_lock, "HERMES_SESSION_SOURCE": "kanban",
        }.items():
            monkeypatch.setenv(name, str(value))
        yield conn, task


@pytest.mark.parametrize("outcome", ["completed", "blocked", "cancelled"])
def test_started_session_survives_every_handoff(worker, outcome):
    conn, task = worker
    assert kb.record_worker_session(conn, "worker-root-session")
    assert kb.record_worker_session(conn, "worker-root-session"), "Startup is idempotent"
    assert not kb.record_worker_session(conn, "unrelated-session")
    assert kb.get_run(conn, task.current_run_id).metadata == {"worker_session_id": "worker-root-session"}
    if outcome == "cancelled":
        kb.cancel_task(conn, task.id)
    elif outcome == "completed":
        assert kb.complete_task(conn, task.id, metadata={"worker_session_id": "replacement", "result": "retained"})
    else:
        assert kb.block_task(conn, task.id, reason="Needs input")
    run = kb.get_run(conn, task.current_run_id)
    assert run.metadata["worker_session_id"] == "worker-root-session"
    if outcome == "completed":
        assert run.metadata["result"] == "retained"
    assert not kb.record_worker_session(conn, "late-session")


@pytest.mark.parametrize("name,value", [
    ("HERMES_KANBAN_TASK", "foreign-task"), ("HERMES_KANBAN_RUN_ID", "999999"),
    ("HERMES_KANBAN_RUN_ID", "not-an-id"), ("HERMES_KANBAN_CLAIM_LOCK", "wrong-claim"),
    ("HERMES_KANBAN_DB", "/nonexistent/other-board.db"), ("HERMES_SESSION_SOURCE", "cli"),
    ("HERMES_HOME", "/nonexistent/other-profile"), ("HERMES_DELEGATED_CHILD_CONTEXT", "1"),
])
def test_foreign_worker_identity_cannot_link_history(worker, monkeypatch, name, value):
    conn, task = worker
    monkeypatch.setenv(name, value)
    assert not kb.record_worker_session(conn, "foreign-session")
    assert kb.get_run(conn, task.current_run_id).metadata is None


@pytest.mark.parametrize("context", [delegated_child_context, non_dispatcher_owned_context])
def test_in_process_children_cannot_link_parent_history(worker, context):
    conn, task = worker
    with context():
        assert not kb.record_worker_session(conn, "child-session")
    assert kb.get_run(conn, task.current_run_id).metadata is None


def test_retry_cannot_reuse_old_worker_identity(worker, monkeypatch):
    conn, task = worker
    assert kb.record_worker_session(conn, "first-session")
    assert kb.block_task(conn, task.id, reason="Retry explicitly")
    assert kb.unblock_task(conn, task.id)
    retry = kb.claim_task(conn, task.id, claimer="new-attempt-claim")
    assert retry and retry.current_run_id != task.current_run_id
    assert not kb.record_worker_session(conn, "stale-session")
    monkeypatch.setenv("HERMES_KANBAN_RUN_ID", str(retry.current_run_id))
    monkeypatch.setenv("HERMES_KANBAN_CLAIM_LOCK", retry.claim_lock)
    assert kb.record_worker_session(conn, "retry-session")
    assert kb.get_run(conn, task.current_run_id).metadata["worker_session_id"] == "first-session"
    assert kb.get_run(conn, retry.current_run_id).metadata["worker_session_id"] == "retry-session"


@pytest.mark.parametrize("session", ["", "../foreign", "spaces not allowed", "s" * 201])
def test_invalid_session_ids_do_not_create_links(worker, session):
    conn, task = worker
    assert not kb.record_worker_session(conn, session)
    assert kb.get_run(conn, task.current_run_id).metadata is None


def test_startup_preserves_existing_run_metadata(worker):
    conn, task = worker
    conn.execute("UPDATE task_runs SET metadata=? WHERE id=?", (json.dumps({"existing": "keep"}), task.current_run_id))
    conn.commit()
    assert kb.record_worker_session(conn, "worker-session")
    assert kb.get_run(conn, task.current_run_id).metadata == {"existing": "keep", "worker_session_id": "worker-session"}
