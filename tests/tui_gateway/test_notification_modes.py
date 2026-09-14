"""Passive task notices must remain durable without starting model/tool work."""
import threading
import queue

import pytest

from hermes_cli import kanban_db as kb
from hermes_state import SessionDB
from tui_gateway import notification_inbox as inbox, server


@pytest.mark.parametrize("inbox_state", ["missing", "finished", "foreign"])
def test_idle_poller_does_not_load_profile_settings(tmp_path, monkeypatch, inbox_state):
    from tools.process_registry import process_registry

    if inbox_state != "missing":
        recipient = "foreign" if inbox_state == "foreign" else "recipient"
        inbox.stage(tmp_path, recipient, "result", "synthetic result")
        if inbox_state == "finished":
            batch = inbox.claim(tmp_path, recipient)
            assert inbox.start(tmp_path, recipient, batch)
            inbox.finish(tmp_path, recipient, batch, "complete")
    before = inbox.inspect(tmp_path, "recipient")
    stop = threading.Event()
    settings_reads = []
    session = {"session_key": "recipient", "profile_home": str(tmp_path),
               "running": False, "history_lock": threading.Lock()}
    monkeypatch.setattr(server, "_collect_kanban_notifications", lambda session: [])
    monkeypatch.setattr(server, "_auto_continue_config",
                        lambda: (settings_reads.append(True) or True, 900, 2))

    def end_poll(**kwargs):
        stop.set()
        raise queue.Empty

    monkeypatch.setattr(process_registry.completion_queue, "get", end_poll)
    server._notification_poller_loop(stop, "runtime", session)
    assert settings_reads == []
    assert inbox.inspect(tmp_path, "recipient") == before
    assert not session["running"]
    if inbox_state == "missing":
        assert not (tmp_path / "sessions" / "notification_inbox.db").exists()


@pytest.mark.parametrize("mode", ["notify", "notify+wake", "wake"])
def test_poller_honors_subscription_delivery_mode(tmp_path, monkeypatch, mode):
    home = tmp_path / "receiver"
    home.mkdir()
    db = SessionDB(db_path=home / "state.db")
    db.create_session("recipient", source="desktop")
    conn = kb.connect()
    task = kb.create_task(conn, title="synthetic result", assignee="specialist")
    kb.add_notify_sub(conn, task_id=task, platform="tui", chat_id="recipient", delivery_mode=mode)
    kb.complete_task(conn, task, summary="passive result must not execute")
    conn.close()
    session = {"session_key": "recipient", "profile_home": str(home), "running": False,
               "history": [], "history_lock": threading.Lock()}
    stop, turns, events = threading.Event(), [], []
    monkeypatch.setattr(server, "_auto_continue_config", lambda: (True, 900, 2))

    def emit(kind, sid, payload=None):
        events.append((kind, payload))
        if mode == "notify" and kind == "status.update" and payload.get("kind") == "task_delivery":
            stop.set()

    def submit(*args, **kwargs):
        turns.append(kwargs)
        stop.set()

    monkeypatch.setattr(server, "_emit", emit)
    monkeypatch.setattr(server, "_run_prompt_submit", submit)
    timer = threading.Timer(3, stop.set)
    timer.start()
    try:
        server._notification_poller_loop(stop, "runtime", session)
        if mode == "notify":
            assert turns == []
            rows = db.get_messages("recipient")
            assert len(rows) == 1
            assert rows[0]["display_kind"] == "kanban_notification"
            assert task in rows[0]["content"]
            receipt = inbox.inspect(home, "recipient")[0]
            assert receipt["state"] == "finished" and receipt["attempts"] == 0
            assert not session["running"]
            assert not any(kind == "message.start" for kind, _ in events)
        else:
            assert len(turns) == 1
            if mode == "wake":
                assert not any(kind == "status.update" for kind, _ in events)
    finally:
        timer.cancel()
        db.close()


def test_passive_receipts_cannot_start_a_model_turn_or_mix_into_an_active_batch(tmp_path):
    inbox.stage(tmp_path, "recipient", "passive", "information", delivery_mode="notify")
    inbox.stage(tmp_path, "recipient", "active", "continue", delivery_mode="notify+wake")
    passive = inbox.claim(tmp_path, "recipient")
    assert [row["id"] for row in passive] == ["passive"]
    assert not inbox.start(tmp_path, "recipient", passive)
    active = inbox.claim(tmp_path, "recipient")
    assert [row["id"] for row in active] == ["active"]
    assert inbox.start(tmp_path, "recipient", active)
    inbox.acknowledge_notice(tmp_path, "recipient", passive)
    assert inbox.inspect(tmp_path, "recipient")[0]["attempts"] == 0


def test_passive_replay_after_append_before_ack_and_compression_is_not_duplicated(tmp_path, monkeypatch):
    db = SessionDB(db_path=tmp_path / "state.db")
    db.create_session("origin", source="desktop")
    inbox.stage(tmp_path, "origin", "notice", "specialist result", delivery_mode="notify")
    first = inbox.claim(tmp_path, "origin")
    session = {"session_key": "origin", "profile_home": str(tmp_path), "running": True,
               "history": [], "history_lock": threading.Lock()}
    events = []
    monkeypatch.setattr(server, "_emit", lambda *args: events.append(args))
    with monkeypatch.context() as fault:
        fault.setattr(inbox, "acknowledge_notice", lambda *args: (_ for _ in ()).throw(OSError("interrupted ack")))
        with pytest.raises(OSError, match="interrupted ack"):
            server._persist_passive_task_notices("runtime", session, first)
    # The poller's pre-start failure path releases the lease. Recovery may now
    # resume at a new compression continuation, with no live history cache.
    inbox.release(tmp_path, "origin", first)
    db.end_session("origin", "compression")
    db.create_session("tip", source="desktop", parent_session_id="origin")
    session.update(session_key="tip", history=[], running=True)
    server._persist_passive_task_notices("runtime", session, inbox.claim(tmp_path, "origin"))
    try:
        assert len(db.get_messages("origin")) == 1
        assert db.get_messages("tip") == []
        assert len(session["history"]) == 1
        assert inbox.inspect(tmp_path, "origin")[0]["state"] == "finished"
        assert inbox.inspect(tmp_path, "origin")[0]["attempts"] == 0
        assert not inbox.claim(tmp_path, "origin")
        assert len(events) == 2  # Same stable ID lets the renderer deduplicate replay.
        assert events[0][2]["display_metadata"]["delivery_ids"] == events[1][2]["display_metadata"]["delivery_ids"]
    finally:
        db.close()


@pytest.mark.parametrize("condition", ["stopped", "foreign"])
def test_passive_delivery_cannot_write_after_stop_or_into_an_unrelated_conversation(tmp_path, monkeypatch, condition):
    db = SessionDB(db_path=tmp_path / "state.db")
    db.create_session("origin", source="desktop")
    db.create_session("foreign", source="desktop")
    inbox.stage(tmp_path, "origin", "notice", "private result", delivery_mode="notify")
    batch = inbox.claim(tmp_path, "origin")
    session = {"session_key": "foreign" if condition == "foreign" else "origin",
               "profile_home": str(tmp_path), "running": True, "history_lock": threading.Lock(),
               "_turn_cancel_requested": condition == "stopped"}
    events = []
    monkeypatch.setattr(server, "_emit", lambda *args: events.append(args))
    try:
        server._persist_passive_task_notices("runtime", session, batch)
        assert not events
        assert not db.get_messages("origin") and not db.get_messages("foreign")
        assert inbox.inspect(tmp_path, "origin")[0]["state"] == "pending"
        assert not session["running"]
    finally:
        db.close()
