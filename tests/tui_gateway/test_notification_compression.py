"""Long-chat compression must not strand or leak specialist return routes."""
import threading

import pytest

from hermes_cli import kanban_db as kb
from hermes_state import SessionDB
from tui_gateway import notification_inbox as inbox, server


@pytest.fixture
def conversation(tmp_path):
    home = tmp_path / "operator"
    home.mkdir()
    db = SessionDB(db_path=home / "state.db")
    db.create_session("origin", source="desktop")
    yield home, db
    db.close()


def compress(db, parent="origin", child="continuation"):
    db.end_session(parent, "compression")
    db.create_session(child, source="desktop", parent_session_id=parent)


def subscribed_task():
    conn = kb.connect()
    try:
        task = kb.create_task(conn, title="long-running specialist", assignee="worker")
        kb.add_notify_sub(conn, task_id=task, platform="tui", chat_id="origin", delivery_mode="notify+wake")
        kb.complete_task(conn, task, summary="result after compression")
        return task
    finally:
        conn.close()


def test_completion_after_compression_reaches_continuation(conversation):
    home, db = conversation
    task = subscribed_task()
    compress(db)
    session = {"session_key": "continuation", "profile_home": str(home)}
    texts = server._collect_kanban_notifications(session)
    assert len(texts) == 1 and task in texts[0]
    assert len(inbox.inspect(home, "origin")) == 1
    assert server._collect_kanban_notifications(session) == []


def test_busy_delivery_is_found_after_cold_resume_of_compressed_chat(conversation, monkeypatch):
    home, db = conversation
    subscribed_task()
    server._collect_kanban_notifications({"session_key": "origin", "profile_home": str(home)})
    compress(db)
    session = {"session_key": "continuation", "profile_home": str(home),
               "running": False, "history_lock": threading.Lock()}
    stop, submissions = threading.Event(), []
    monkeypatch.setattr(server, "_maybe_fire_tui_loop_tick", lambda *args: None, raising=False)
    monkeypatch.setattr(server, "_auto_continue_config", lambda: (True, 900, 2))
    monkeypatch.setattr(server, "_emit", lambda *args: None)

    def submit(*args, **kwargs):
        submissions.append(kwargs["kanban_batch"])
        stop.set()

    # Bound a regression failure: never leave a poller running indefinitely.
    timer = threading.Timer(3, stop.set)
    monkeypatch.setattr(server, "_run_prompt_submit", submit)
    timer.start()
    try:
        server._notification_poller_loop(stop, "runtime", session)
    finally:
        timer.cancel()
    assert len(submissions) == 1
    assert submissions[0][0]["session_key"] == "origin"


def test_old_live_session_does_not_collect_after_rotation(conversation):
    home, db = conversation
    subscribed_task()
    compress(db)
    assert server._collect_kanban_notifications({"session_key": "origin", "profile_home": str(home)}) == []
    assert inbox.inspect(home, "origin") == []


def test_finished_receipt_keeps_identity_across_multiple_compressions(conversation):
    home, db = conversation
    task = subscribed_task()
    original = {"session_key": "origin", "profile_home": str(home)}
    server._collect_kanban_notifications(original)
    batch = inbox.claim(home, "origin")
    assert inbox.start(home, "origin", batch)
    inbox.finish(home, "origin", batch, "complete")
    delivery_id = batch[0]["id"]
    compress(db)
    compress(db, "continuation", "latest")
    conn = kb.connect()
    try:
        # Simulate replay after a lost board cursor. The durable ID must not
        # change just because the operator now occupies another continuation.
        conn.execute("UPDATE kanban_notify_subs SET last_event_id=0 WHERE task_id=?", (task,))
        assert server._collect_kanban_notifications({"session_key": "latest", "profile_home": str(home)}) == []
        assert kb.list_notify_subs(conn, task_id=task)[0]["last_event_id"] > 0
    finally:
        conn.close()
    rows = inbox.inspect(home, "origin")
    assert len(rows) == 1 and rows[0]["id"] == delivery_id and rows[0]["state"] == "finished"
    assert db.get_compression_delivery_keys("latest") == ["latest", "continuation", "origin"]


def test_a_compressed_branch_inherits_only_its_own_tasks(conversation):
    _home, db = conversation
    db.end_session("origin", "compression")
    db.create_session("branch", source="desktop", parent_session_id="origin",
                      model_config={"_branched_from": "origin"})
    compress(db, "branch", "branch-tip")
    assert db.get_compression_delivery_keys("branch-tip") == ["branch-tip", "branch"]


def test_recipient_lookup_does_not_create_a_missing_profile(tmp_path):
    home = tmp_path / "missing-profile"
    assert server._notification_recipient_keys({"session_key": "lazy", "profile_home": str(home)}) == ["lazy"]
    assert not home.exists()


@pytest.mark.parametrize("kind", ["branch", "delegate", "tool", "ordinary-child", "other-profile"])
def test_non_continuations_cannot_inherit_return_routes(conversation, tmp_path, kind):
    home, db = conversation
    subscribed_task()
    if kind != "ordinary-child":
        db.end_session("origin", "compression")
    metadata = {"_branched_from": "origin"} if kind == "branch" else (
        {"_delegate_from": "origin"} if kind == "delegate" else None)
    db.create_session("unrelated", source="tool" if kind == "tool" else "desktop",
                      parent_session_id="origin", model_config=metadata)
    if kind == "other-profile":
        home = tmp_path / "other-profile"
        home.mkdir()
        other = SessionDB(db_path=home / "state.db")
        other.create_session("unrelated", source="desktop")
        other.close()
    assert server._collect_kanban_notifications({"session_key": "unrelated", "profile_home": str(home)}) == []
    assert inbox.inspect(home, "origin") == []
