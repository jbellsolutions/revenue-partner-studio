"""Startup cleanup must never reach another computer/profile home."""
from types import SimpleNamespace

import psutil
import pytest

from hermes_cli import dashboard_procs as procs


@pytest.mark.parametrize("scope", ["same", "foreign", "missing", "denied", "not-desktop"])
def test_orphan_reap_requires_proven_same_home(tmp_path, monkeypatch, scope):
    own = tmp_path / "own-profile"
    environment = {"HERMES_HOME": str(own), "HERMES_DESKTOP": "1"}
    if scope == "foreign":
        environment["HERMES_HOME"] = str(tmp_path / "another-computer")
    elif scope == "missing":
        environment.pop("HERMES_HOME")
    elif scope == "not-desktop":
        environment.pop("HERMES_DESKTOP")

    def environ():
        if scope == "denied":
            raise psutil.AccessDenied(987654)
        return environment

    signals = []
    monkeypatch.setattr(procs, "_hermes_home_dir", lambda: own)
    monkeypatch.setattr(procs, "_scan_dashboard_processes", lambda **kw: [
        (987654, "hermes serve --isolated --host 127.0.0.1 --port 0")])
    monkeypatch.setattr(procs, "_process_ppid", lambda pid: 1)
    monkeypatch.setattr(procs, "_process_age_seconds", lambda pid: 600, raising=False)
    monkeypatch.setattr(psutil, "Process", lambda pid: SimpleNamespace(environ=environ))
    monkeypatch.setattr(psutil, "pid_exists", lambda pid: False)
    monkeypatch.setattr(procs.os, "kill", lambda pid, sig: signals.append((pid, sig)))
    monkeypatch.setattr(procs.sys, "platform", "linux")
    result = procs._reap_orphaned_desktop_local_serves(
        lock_owned_pids_fn=lambda: set(), sleep_fn=lambda seconds: None,
        signal_term=15, signal_kill=9,
    )
    if scope == "same":
        assert signals == [(987654, 15)]
        assert result["killed"] == [987654]
    else:
        assert signals == []
        assert result["matched"] == []
