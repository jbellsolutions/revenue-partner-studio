"""Durable, profile-local delivery of task results to an operator conversation.

Stage before advancing a board cursor. IDs are deterministic, including board
and recipient identity; finished rows are retained as deduplication receipts.
Only pre-start leases can expire. Running work is retried after confirmed owner
process death, with a reconciliation prompt and a three-start limit. This is
at-least-once recovery, never an exactly-once guarantee for external actions.
"""

from __future__ import annotations

import contextlib
import json
import os
import sqlite3
import time
import uuid
from pathlib import Path

import psutil

_MAX_STARTS = 3
_LEASE_SECONDS = 60
_MAX_BATCH = 20
_MAX_PENDING = 10_000


@contextlib.contextmanager
def _connect(home):
    # Existing profile clone/export rules exclude sessions by default. Do not
    # put workflow history in a settings directory that clone-all would copy.
    directory = Path(home) / "sessions"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "notification_inbox.db"
    # Create with private permissions before SQLite opens it (no chmod window).
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    os.close(fd)
    conn = sqlite3.connect(path, timeout=10, isolation_level=None)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA synchronous=FULL")
        conn.execute("""CREATE TABLE IF NOT EXISTS deliveries (
            id TEXT PRIMARY KEY, session_key TEXT NOT NULL, text TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
            owner TEXT, pid INTEGER, pid_started REAL, lease_until REAL, created_at REAL NOT NULL,
            updated_at REAL NOT NULL, outcome TEXT
        )""")
        conn.execute("CREATE INDEX IF NOT EXISTS delivery_session ON deliveries(session_key, state)")
        conn.execute("BEGIN IMMEDIATE")
        if "metadata" not in {row[1] for row in conn.execute("PRAGMA table_info(deliveries)")}:
            conn.execute("ALTER TABLE deliveries ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'")
        if "delivery_mode" not in {row[1] for row in conn.execute("PRAGMA table_info(deliveries)")}:
            # Already-staged legacy deliveries were admitted as active turns.
            conn.execute("ALTER TABLE deliveries ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'notify+wake'")
        yield conn
        conn.execute("COMMIT")
    except BaseException:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()


def stage(home, session_key: str, delivery_id: str, text: str, *, metadata: dict | None = None,
          delivery_mode: str = "notify+wake") -> bool:
    """Persist before claiming the source cursor; repeated IDs are harmless."""
    if not session_key or not delivery_id or not text:
        raise ValueError("notification requires a recipient, id, and text")
    if delivery_mode not in {"notify", "notify+wake", "wake"}:
        raise ValueError("invalid notification delivery mode")
    now = time.time()
    with _connect(home) as conn:
        if conn.execute("SELECT 1 FROM deliveries WHERE id=?", (delivery_id,)).fetchone():
            return False
        if conn.execute("SELECT COUNT(*) FROM deliveries WHERE state!='finished'").fetchone()[0] >= _MAX_PENDING:
            # Do not discard oldest work. Fail before the source cursor moves;
            # delivery resumes after the backlog has been dealt with.
            raise RuntimeError("Task-result inbox backlog limit reached")
        cur = conn.execute(
            "INSERT OR IGNORE INTO deliveries(id,session_key,text,created_at,updated_at,metadata,delivery_mode) "
            "VALUES(?,?,?,?,?,?,?)",
            (delivery_id, session_key, text, now, now, json.dumps(metadata or {}, ensure_ascii=True), delivery_mode),
        )
        return cur.rowcount == 1


def _owner_alive(pid: int | None, started: float | None) -> bool:
    if not pid:
        return False
    try:
        process = psutil.Process(pid)
        # PID reuse after a reboot must not strand work behind an unrelated
        # live process. psutil is the project's cross-platform PID primitive;
        # unlike os.kill(pid, 0), it is also a safe Windows probe.
        return process.create_time() == started and process.status() != psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return False
    except (psutil.AccessDenied, OSError):
        return True  # Uncertain ownership is not permission to replay work.


def has_pending(home, session_key: str) -> bool:
    """Read-only probe for work needing admission or owner recovery."""
    return bool(_read(home, session_key, "state IN ('pending','leased','running')"))


def claim(home, session_key: str, *, recover_running: bool = True,
          freshness_seconds: float = 900, max_recoveries: int = 2) -> list[dict]:
    """Lease a bounded batch; recover only expired pre-start or dead-owner work."""
    if not has_pending(home, session_key):
        return []
    now = time.time()
    with _connect(home) as conn:
        rows = conn.execute(
            "SELECT * FROM deliveries WHERE session_key=? AND state IN ('leased','running')",
            (session_key,),
        ).fetchall()
        for row in rows:
            recover = (
                row["state"] == "leased" and row["lease_until"] < now
            ) or not _owner_alive(row["pid"], row["pid_started"])
            if recover:
                interrupted = row["attempts"] > 0
                blocked = interrupted and (
                    not recover_running
                    or now - row["updated_at"] > freshness_seconds
                    or row["attempts"] >= min(_MAX_STARTS, 1 + max(0, max_recoveries))
                )
                state = "blocked" if blocked else "pending"
                conn.execute(
                    "UPDATE deliveries SET state=?,owner=NULL,pid=NULL,updated_at=?,outcome=? WHERE id=?",
                    (state, now, "recovery paused by settings, age, or retry limit" if blocked
                     else "owner stopped; reconcile before repeating actions", row["id"]),
                )
        pending = conn.execute(
            "SELECT * FROM deliveries WHERE session_key=? AND state='pending' AND delivery_mode="
            "(SELECT delivery_mode FROM deliveries WHERE session_key=? AND state='pending' "
            "ORDER BY created_at,id LIMIT 1) ORDER BY created_at,id LIMIT ?",
            (session_key, session_key, _MAX_BATCH),
        ).fetchall()
        lease = uuid.uuid4().hex
        pid_started = psutil.Process(os.getpid()).create_time()
        for row in pending:
            conn.execute(
                "UPDATE deliveries SET state='leased',owner=?,pid=?,pid_started=?,lease_until=?,updated_at=? WHERE id=?",
                (lease, os.getpid(), pid_started, now + _LEASE_SECONDS, now, row["id"]),
            )
        return [dict(row, lease=lease) for row in pending]


def start(home, session_key: str, batch: list[dict]) -> bool:
    """Checkpoint before any model/tool call; a stale lease cannot start work."""
    if not batch:
        return False
    now = time.time()
    with _connect(home) as conn:
        for item in batch:
            row = conn.execute(
                "SELECT state,owner,lease_until,delivery_mode FROM deliveries WHERE id=? AND session_key=?",
                (item["id"], session_key),
            ).fetchone()
            if (not row or row["state"] != "leased" or row["owner"] != item["lease"]
                    or row["lease_until"] < now or row["delivery_mode"] == "notify"):
                return False
        for item in batch:
            conn.execute(
                "UPDATE deliveries SET state='running',attempts=attempts+1,updated_at=? WHERE id=?",
                (now, item["id"]),
            )
    return True


def release(home, session_key: str, batch: list[dict]) -> None:
    """A dispatch failure before start is safe to retry and spends no attempt."""
    with _connect(home) as conn:
        for item in batch:
            conn.execute(
                "UPDATE deliveries SET state='pending',owner=NULL,pid=NULL,updated_at=? "
                "WHERE id=? AND session_key=? AND state='leased' AND owner=?",
                (time.time(), item["id"], session_key, item["lease"]),
            )


def finish(home, session_key: str, batch: list[dict], outcome: str) -> None:
    """Concluded errors/cancellation never trigger automatic model retries."""
    with _connect(home) as conn:
        for item in batch:
            conn.execute(
                "UPDATE deliveries SET state='finished',outcome=?,updated_at=?,text='',metadata='{}' "
                "WHERE id=? AND session_key=? AND state='running' AND owner=?",
                (outcome, time.time(), item["id"], session_key, item["lease"]),
            )


def acknowledge_notice(home, session_key: str, batch: list[dict]) -> None:
    """Retire a persisted passive notice without recording a model attempt."""
    with _connect(home) as conn:
        for item in batch:
            conn.execute(
                "UPDATE deliveries SET state='finished',outcome='passive notice persisted',updated_at=?,"
                "text='',metadata='{}' WHERE id=? AND session_key=? AND state='leased' "
                "AND owner=? AND delivery_mode='notify'",
                (time.time(), item["id"], session_key, item["lease"]),
            )


def inspect(home, session_key: str) -> list[dict]:
    return _read(home, session_key)


def blocked(home, session_key: str) -> list[dict]:
    return _read(home, session_key, "state='blocked'")


def _read(home, session_key: str, condition: str = "1") -> list[dict]:
    path = Path(home) / "sessions" / "notification_inbox.db"
    if not path.exists():
        return []
    conn = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        return [dict(row) for row in conn.execute(
            "SELECT * FROM deliveries WHERE session_key=? AND " + condition + " ORDER BY created_at,id",
            (session_key,),
        )]
    finally:
        conn.close()
