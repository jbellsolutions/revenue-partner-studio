import concurrent.futures
import json
import os
import sqlite3
import subprocess
import sys

import pytest

from tui_gateway import notification_inbox as inbox


def test_existing_inbox_is_upgraded_without_losing_pending_work(tmp_path):
    directory = tmp_path / "sessions"
    directory.mkdir()
    with sqlite3.connect(directory / "notification_inbox.db") as conn:
        conn.execute("""CREATE TABLE deliveries (
            id TEXT PRIMARY KEY, session_key TEXT NOT NULL, text TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
            owner TEXT, pid INTEGER, pid_started REAL, lease_until REAL, created_at REAL NOT NULL,
            updated_at REAL NOT NULL, outcome TEXT
        )""")
        conn.execute("INSERT INTO deliveries(id,session_key,text,created_at,updated_at) VALUES(?,?,?,?,?)",
                     ("old", "operator", "existing result", 1, 1))
    batch = inbox.claim(tmp_path, "operator")
    assert batch[0]["text"] == "existing result"
    assert json.loads(batch[0]["metadata"]) == {}
    assert inbox.start(tmp_path, "operator", batch)
    inbox.finish(tmp_path, "operator", batch, "complete")
    assert not inbox.stage(tmp_path, "operator", "old", "existing result")


def test_task_attribution_survives_lease_recovery_and_is_retired(tmp_path):
    metadata = {"task_id": "t_1", "board": "team", "worker": "researcher"}
    inbox.stage(tmp_path, "operator", "id", "done", metadata=metadata)
    first = inbox.claim(tmp_path, "operator")
    assert json.loads(first[0]["metadata"]) == metadata
    inbox.release(tmp_path, "operator", first)
    second = inbox.claim(tmp_path, "operator")
    assert json.loads(second[0]["metadata"]) == metadata
    assert inbox.start(tmp_path, "operator", second)
    inbox.finish(tmp_path, "operator", second, "complete")
    assert inbox.inspect(tmp_path, "operator")[0]["metadata"] == "{}"


def test_stage_deduplicates_even_after_completed_delivery(tmp_path):
    assert inbox.stage(tmp_path, "operator", "id", "@specialist done")
    batch = inbox.claim(tmp_path, "operator")
    assert inbox.start(tmp_path, "operator", batch)
    inbox.finish(tmp_path, "operator", batch, "complete")
    assert not inbox.stage(tmp_path, "operator", "id", "@specialist done")
    assert not inbox.claim(tmp_path, "operator")
    assert inbox.inspect(tmp_path, "operator")[0]["outcome"] == "complete"


def test_private_profile_and_conversation_boundaries(tmp_path):
    inbox.stage(tmp_path / "a", "operator-a", "id", "private")
    assert not inbox.claim(tmp_path / "b", "operator-a")
    assert not inbox.claim(tmp_path / "a", "operator-b")
    batch = inbox.claim(tmp_path / "a", "operator-a")
    assert not inbox.start(tmp_path / "a", "operator-b", batch)
    assert inbox.start(tmp_path / "a", "operator-a", batch)


def test_concurrent_pollers_have_one_owner(tmp_path):
    inbox.stage(tmp_path, "operator", "id", "done")
    with concurrent.futures.ThreadPoolExecutor(2) as pool:
        batches = list(pool.map(lambda _: inbox.claim(tmp_path, "operator"), range(2)))
    assert sorted(map(len, batches)) == [0, 1]


def test_expired_lease_cannot_start_or_finish_replacement(tmp_path, monkeypatch):
    inbox.stage(tmp_path, "operator", "id", "done")
    now = inbox.time.time()
    old = inbox.claim(tmp_path, "operator")
    monkeypatch.setattr(inbox.time, "time", lambda: now + 61)
    new = inbox.claim(tmp_path, "operator")
    assert not inbox.start(tmp_path, "operator", old)
    assert inbox.start(tmp_path, "operator", new)
    inbox.finish(tmp_path, "operator", old, "error")
    assert inbox.inspect(tmp_path, "operator")[0]["state"] == "running"


def test_live_running_owner_never_replayed_on_timer(tmp_path, monkeypatch):
    inbox.stage(tmp_path, "operator", "id", "done")
    batch = inbox.claim(tmp_path, "operator")
    assert inbox.start(tmp_path, "operator", batch)
    now = inbox.time.time()
    monkeypatch.setattr(inbox.time, "time", lambda: now + 99999)
    assert not inbox.claim(tmp_path, "operator")


def test_dead_owner_recovery_is_bounded(tmp_path, monkeypatch):
    inbox.stage(tmp_path, "operator", "id", "done")
    monkeypatch.setattr(inbox, "_owner_alive", lambda *args: False)
    for attempt in range(3):
        batch = inbox.claim(tmp_path, "operator")
        assert batch[0]["attempts"] == attempt
        assert inbox.start(tmp_path, "operator", batch)
    assert not inbox.claim(tmp_path, "operator")
    assert inbox.blocked(tmp_path, "operator")[0]["id"] == "id"


@pytest.mark.parametrize("settings", [
    {"recover_running": False}, {"max_recoveries": 0}, {"freshness_seconds": -1},
])
def test_recovery_respects_disabled_stale_and_retry_settings(tmp_path, monkeypatch, settings):
    inbox.stage(tmp_path, "operator", "id", "done")
    batch = inbox.claim(tmp_path, "operator")
    assert inbox.start(tmp_path, "operator", batch)
    monkeypatch.setattr(inbox, "_owner_alive", lambda *args: False)
    assert not inbox.claim(tmp_path, "operator", **settings)
    assert inbox.blocked(tmp_path, "operator")


def test_release_before_start_spends_no_model_attempt(tmp_path):
    inbox.stage(tmp_path, "operator", "id", "done")
    old = inbox.claim(tmp_path, "operator")
    inbox.release(tmp_path, "operator", old)
    new = inbox.claim(tmp_path, "operator")
    assert new[0]["attempts"] == 0
    assert not inbox.start(tmp_path, "operator", old)


def test_cancelled_or_handled_error_is_not_automatically_retried(tmp_path):
    for outcome in ("interrupted", "error"):
        inbox.stage(tmp_path, "operator", outcome, "done")
        batch = inbox.claim(tmp_path, "operator")
        assert inbox.start(tmp_path, "operator", batch)
        inbox.finish(tmp_path, "operator", batch, outcome)
        assert not inbox.claim(tmp_path, "operator")


def test_real_process_death_recovers_persisted_started_work(tmp_path):
    code = (
        "from tui_gateway import notification_inbox as i; import sys, os; "
        "h=sys.argv[1]; i.stage(h,'operator','id','done'); "
        "b=i.claim(h,'operator'); assert i.start(h,'operator',b); os._exit(9)"
    )
    proc = subprocess.run([sys.executable, "-c", code, str(tmp_path)], check=False)
    assert proc.returncode == 9
    batch = inbox.claim(tmp_path, "operator")
    assert batch[0]["attempts"] == 1
    assert inbox.start(tmp_path, "operator", batch)
    inbox.finish(tmp_path, "operator", batch, "complete")
    assert not inbox.claim(tmp_path, "operator")


def test_file_is_owner_only_on_posix(tmp_path):
    if os.name == "posix":
        inbox.stage(tmp_path, "operator", "id", "private")
        assert (tmp_path / "sessions/notification_inbox.db").stat().st_mode & 0o077 == 0


def test_pid_reuse_is_not_mistaken_for_live_owner():
    process = inbox.psutil.Process(os.getpid())
    assert inbox._owner_alive(os.getpid(), process.create_time())
    assert not inbox._owner_alive(os.getpid(), process.create_time() - 10)


def test_empty_poll_does_not_create_a_database(tmp_path):
    assert inbox.claim(tmp_path, "operator") == []
    assert inbox.blocked(tmp_path, "operator") == []
    assert not (tmp_path / "sessions").exists()


def test_full_backlog_fails_without_discarding_work(tmp_path, monkeypatch):
    monkeypatch.setattr(inbox, "_MAX_PENDING", 1)
    inbox.stage(tmp_path, "operator", "id", "done")
    assert not inbox.stage(tmp_path, "operator", "id", "duplicate")
    with pytest.raises(RuntimeError, match="backlog"):
        inbox.stage(tmp_path, "operator", "next", "must not discard")
    assert len(inbox.inspect(tmp_path, "operator")) == 1


def test_profile_clone_does_not_copy_workflow_history(tmp_path):
    import shutil
    from hermes_cli.profiles import _clone_all_copytree_ignore

    source, destination = tmp_path / "source", tmp_path / "clone"
    inbox.stage(source, "operator", "id", "private task result")
    shutil.copytree(source, destination, ignore=_clone_all_copytree_ignore(source))
    assert not inbox.inspect(destination, "operator")
    assert inbox.inspect(source, "operator")[0]["text"] == "private task result"
