"""Explicit task cancellation: durable stop intent, then owned-process cleanup."""

from pathlib import Path
from typing import Any, Optional
import json
import os
import socket
import sqlite3

import psutil


def _live(process: psutil.Process) -> bool:
    try:
        return process.is_running() and process.status() != psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return False
    except psutil.AccessDenied:
        return True


def _saved_targets(conn, task_id):
    """Keep every verified identity in this cancellation cycle, not older runs."""
    rows = conn.execute(
        "SELECT payload FROM task_events WHERE task_id=? AND kind='cancel_targets' "
        "AND id > (SELECT max(id) FROM task_events WHERE task_id=? AND kind='cancelled') ORDER BY id",
        (task_id, task_id),
    ).fetchall()
    targets = set()
    for row in rows:
        payload = json.loads(row[0])
        if payload["host"] != socket.gethostname() or payload["boot_time"] != psutil.boot_time():
            raise ValueError("Cleanup ownership belongs to another host or boot")
        targets.update((int(item["pid"]), float(item["created_at"])) for item in payload["processes"])
    return targets


def _save_targets(conn, task_id, targets):
    from hermes_cli import kanban_db as kb

    with kb.write_txn(conn):
        kb._append_event(conn, task_id, "cancel_targets", {
            "host": socket.gethostname(), "boot_time": psutil.boot_time(),
            "processes": [{"pid": pid, "created_at": created} for pid, created in sorted(targets)],
        })


def _stop_owned_worker(conn, pid: Optional[int], claim: Optional[str], task_id: str, board_path: str) -> dict[str, Any]:
    if not pid:
        if claim:
            return {"stopped": False, "reason": "worker_start_pending"}
        return {"stopped": True, "reason": "no_worker"}
    if not claim or not board_path:
        return {"stopped": False, "reason": "worker_identity_unavailable"}
    try:
        targets = _saved_targets(conn, task_id)
        if not targets:
            try:
                worker = psutil.Process(pid)
                if not _live(worker):
                    return {"stopped": True, "reason": "already_exited"}
                env = worker.environ()
                if (env.get("HERMES_KANBAN_TASK") != task_id
                        or env.get("HERMES_KANBAN_CLAIM_LOCK") != claim
                        or not env.get("HERMES_KANBAN_DB")
                        or Path(env["HERMES_KANBAN_DB"]).resolve() != Path(board_path).resolve()):
                    return {"stopped": False, "reason": "worker_identity_mismatch"}
                owned = worker.children(recursive=True) + [worker]
                targets = {(process.pid, process.create_time()) for process in owned}
                # Commit ownership BEFORE any signal. A retry must still find
                # descendants when their root has already exited.
                _save_targets(conn, task_id, targets)
            except psutil.NoSuchProcess:
                return {"stopped": False, "reason": "worker_exited_during_identification"}
        owned = []
        for target_pid, created_at in targets:
            try:
                process = psutil.Process(target_pid)
                if process.create_time() == created_at:
                    owned.append(process)
                # A reused PID is NOT our old worker; never signal it.
            except psutil.NoSuchProcess:
                pass
        # Children first, root last. Do not abandon known descendants when
        # another signal is denied or a process disappears mid-cleanup.
        owned.sort(key=lambda process: process.pid == pid)
        if any(process.pid == os.getpid() for process in owned):
            # A worker's own terminal can invoke this CLI. Killing that
            # caller would interrupt cleanup halfway through its tree.
            return {"stopped": False, "reason": "cancellation_requires_external_controller"}
        for process in owned:
            try:
                process.terminate()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
        psutil.wait_procs(owned, timeout=3)
        for process in list(owned):
            if not _live(process):
                continue
            try:
                for child in process.children(recursive=True):
                    identity = (child.pid, child.create_time())
                    if identity not in targets:
                        targets.add(identity)
                        owned.append(child)
            except psutil.NoSuchProcess:
                pass
        # Save late descendants too, before escalation. Never use a PID scan.
        _save_targets(conn, task_id, targets)
        for process in owned:
            if _live(process):
                try:
                    process.kill()
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
        psutil.wait_procs(owned, timeout=3)
        stopped = not any(_live(process) for process in owned)
        return {"stopped": stopped, "reason": "terminated" if stopped else "worker_still_running"}
    except (psutil.AccessDenied, OSError, ValueError, KeyError, TypeError):
        return {"stopped": False, "reason": "worker_identity_unavailable"}


def cancel_task(conn: sqlite3.Connection, task_id: str, *, reason: Optional[str] = None) -> Optional[dict[str, Any]]:
    """Cancel one task without releasing dependents or retrying its worker.

    Cancellation does not undo completed effects or cancel separate child tasks.
    A failed ownership/termination check leaves durable cancellation intent and
    the worker identity available for a later explicit cancellation retry. Callers
    must surface ``ok=False``; it must not be presented as a stopped worker.
    """
    from hermes_cli import kanban_db as kb

    if conn.in_transaction:
        raise RuntimeError("Cancellation requires its own transaction before process cleanup")
    board_path = next((str(row[2]) for row in conn.execute("PRAGMA database_list") if row[1] == "main"), "")
    with kb.write_txn(conn):
        row = conn.execute("SELECT status, worker_pid, claim_lock FROM tasks WHERE id=?", (task_id,)).fetchone()
        if row is None:
            return None
        if row["status"] in {"done", "archived"}:
            raise ValueError(f"Task is already {row['status']}; cancellation cannot undo its result")
        pid, claim = row["worker_pid"], row["claim_lock"]
        if row["status"] != "cancelled":
            # Publish the terminal intent before signalling: a late completion
            # loses its state/run compare-and-set, and no dispatcher can retry.
            # Keep worker identity until its termination is positively known.
            conn.execute("UPDATE tasks SET status='cancelled' WHERE id=?", (task_id,))
            run_id = kb._end_run(conn, task_id, outcome="cancelled", status="cancelled", summary=reason)
            kb._append_event(conn, task_id, "cancelled", {"reason": reason}, run_id=run_id)
    termination = _stop_owned_worker(conn, pid, claim, task_id, board_path)
    with kb.write_txn(conn):
        current = conn.execute(
            "SELECT id FROM tasks WHERE id=? AND status='cancelled' AND claim_lock IS ? AND worker_pid IS ?",
            (task_id, claim, pid),
        ).fetchone()
        if current is not None:
            if termination["stopped"]:
                conn.execute(
                    "UPDATE tasks SET worker_pid=NULL, claim_lock=NULL, claim_expires=NULL WHERE id=?",
                    (task_id,),
                )
            # Publish AFTER cleanup so socket subscribers do not get stuck
            # showing the pre-signal pending state until a fallback poll.
            kb._append_event(conn, task_id, "cancel_cleanup", {
                "worker_stopped": termination["stopped"], "reason": termination["reason"],
            })
    return {"ok": termination["stopped"], "task_id": task_id, "status": "cancelled",
            "worker_stopped": termination["stopped"], "termination": termination}
