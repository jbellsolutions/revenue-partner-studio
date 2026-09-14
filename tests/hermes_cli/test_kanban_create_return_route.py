"""Real SQLite coverage for CLI/tool task creation and its chat return route."""

import json
from contextlib import contextmanager

import pytest

from gateway.session_context import clear_session_vars, set_session_vars
from hermes_cli import kanban as cli
from hermes_cli import kanban_db as kb


@contextmanager
def origin(**fields):
    tokens = set_session_vars(**fields)
    try:
        yield
    finally:
        clear_session_vars(tokens)


def create(command="create 'return-route test' --assignee specialist --json"):
    return json.loads(cli.run_slash(command))


def test_cli_stamps_origin_without_enabling_notifications():
    with origin(session_id="operator-history", session_key="operator-channel"):
        task = create()
    assert task["session_id"] == "operator-history"
    assert "subscribed" not in task
    with kb.connect_closing() as conn:
        assert kb.list_notify_subs(conn, task["id"]) == []


def test_api_origin_uses_request_chat_not_child_agent_id():
    with origin(platform="api_server", chat_id="operator-request", session_id="child-internal"):
        task = create()
    assert task["session_id"] == "operator-request"


def test_explicit_notify_has_durable_route_and_is_idempotent():
    command = "create 'return-route test' --assignee specialist --notify --idempotency-key return-once --json"
    with origin(session_id="operator-history", session_key="operator-channel", profile="default"):
        first = create(command)
        second = create(command)
    assert first["subscribed"] is True
    assert first["id"] == second["id"]
    with kb.connect_closing() as conn:
        subs = kb.list_notify_subs(conn, first["id"])
        assert len(subs) == 1
        assert subs[0]["chat_id"] == "operator-channel"
        assert subs[0]["platform"] == "tui"
        assert kb.get_task(conn, first["id"]).session_id == "operator-history"


def test_scoped_callers_do_not_inherit_foreign_process_channel(monkeypatch):
    monkeypatch.setenv("HERMES_SESSION_KEY", "foreign-global")
    monkeypatch.setenv("HERMES_SESSION_ID", "foreign-global-history")
    tasks = []
    for name in ("operator-a", "operator-b"):
        with origin(session_id=name, session_key=name + "-channel"):
            tasks.append(create("create 'scoped task' --assignee specialist --notify --json"))
    with kb.connect_closing() as conn:
        for task, name in zip(tasks, ("operator-a", "operator-b")):
            assert task["session_id"] == name
            assert kb.list_notify_subs(conn, task["id"])[0]["chat_id"] == name + "-channel"


def test_idempotent_create_does_not_reenable_a_return_route_changed_to_passive():
    command = "create 'passive return' --assignee specialist --notify --idempotency-key passive-once --json"
    with origin(session_id="operator-history", session_key="operator-channel", profile="default"):
        first = create(command)
        with kb.connect_closing() as conn:
            assert kb.list_notify_subs(conn, first["id"])[0]["delivery_mode"] == "notify+wake"
            kb.add_notify_sub(conn, task_id=first["id"], platform="tui", chat_id="operator-channel",
                              delivery_mode="notify")
        assert create(command)["id"] == first["id"]
    with kb.connect_closing() as conn:
        assert kb.list_notify_subs(conn, first["id"])[0]["delivery_mode"] == "notify"


def test_notify_without_return_channel_does_not_promise_delivery(monkeypatch):
    # A context-local empty binding must mask a different session's global
    # mirror, not fall through and subscribe to that foreign conversation.
    monkeypatch.setenv("HERMES_SESSION_KEY", "foreign-global-channel")
    with origin(session_id="one-shot-cli", session_key=""):
        task = create("create 'no channel' --assignee specialist --notify --json")
    assert task["subscribed"] is False
    with kb.connect_closing() as conn:
        assert kb.get_task(conn, task["id"]) is not None
        assert kb.list_notify_subs(conn, task["id"]) == []


def test_task_is_not_visible_to_dispatcher_before_subscription(monkeypatch):
    from tools import kanban_tools as kt

    subscribe = kt._maybe_auto_subscribe
    observed = []

    def inspect_before_subscribe(conn, task_id):
        # Another connection is the dispatcher boundary. Neither the task nor
        # its return route may leak out of the outer creation transaction.
        with kb.connect_closing() as observer:
            observed.append(kb.get_task(observer, task_id))
        return subscribe(conn, task_id)

    monkeypatch.setattr(kt, "_maybe_auto_subscribe", inspect_before_subscribe)
    with origin(session_id="operator", session_key="operator-channel"):
        task = create("create 'atomic return' --assignee specialist --notify --json")
    assert observed == [None]
    assert task["subscribed"] is True


def test_unexpected_creation_failure_rolls_back_task_and_return_route(monkeypatch):
    from tools import kanban_tools as kt

    subscribe = kt._maybe_auto_subscribe

    def fail_after_subscription(conn, task_id):
        assert subscribe(conn, task_id)
        raise RuntimeError("crash before creation commit")

    monkeypatch.setattr(kt, "_maybe_auto_subscribe", fail_after_subscription)
    with origin(session_id="operator", session_key="operator-channel"):
        with kb.connect_closing() as conn:
            with pytest.raises(RuntimeError, match="before creation commit"):
                kt._create_task_with_notification(conn, title="uncommitted", assignee="specialist")
    with kb.connect_closing() as conn:
        assert not kb.list_tasks(conn)
        assert not kb.list_notify_subs(conn)
