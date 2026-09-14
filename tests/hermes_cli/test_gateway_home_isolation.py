"""A startup/restart sweep is not authority over another profile's gateway."""
from types import SimpleNamespace

import psutil
import pytest

from hermes_cli import gateway
from gateway import status


@pytest.mark.parametrize("scope", ["same", "foreign", "missing", "denied", "relative"])
def test_gateway_orphan_reap_requires_proven_same_home(tmp_path, monkeypatch, scope):
    own = tmp_path / "own-profile"
    monkeypatch.setenv("HERMES_HOME", str(own))
    environment = {"HERMES_HOME": str(own)}
    if scope == "foreign":
        environment["HERMES_HOME"] = str(tmp_path / "another-computer")
    elif scope == "missing":
        environment.clear()
    elif scope == "relative":
        environment["HERMES_HOME"] = "."

    def environ():
        if scope == "denied":
            raise psutil.AccessDenied(987654)
        return environment

    signals, markers = [], []
    monkeypatch.setattr(gateway, "supports_systemd_services", lambda: False)
    monkeypatch.setattr(gateway, "is_windows", lambda: False, raising=False)
    monkeypatch.setattr(gateway, "find_gateway_pids", lambda **kw: [987654])
    monkeypatch.setattr(gateway, "_get_service_pids", lambda **kw: set(), raising=False)
    monkeypatch.setattr(gateway, "_reaper_candidate_is_supervisor_owned", lambda pid: False, raising=False)
    monkeypatch.setattr(status, "get_running_pid", lambda **kw: None)
    monkeypatch.setattr(status, "_read_pid_record", lambda: None, raising=False)
    monkeypatch.setattr(status, "_read_gateway_lock_record", lambda: None, raising=False)
    monkeypatch.setattr(status, "write_planned_stop_marker", lambda pid: markers.append(pid))
    monkeypatch.setattr(status, "_pid_exists", lambda pid: False)
    monkeypatch.setattr(psutil, "Process", lambda pid: SimpleNamespace(environ=environ))
    monkeypatch.setattr(gateway.os, "kill", lambda pid, sig: signals.append((pid, sig)))
    reaped = gateway._reap_unsupervised_gateway_orphans()
    if scope == "same":
        assert reaped and len(signals) == 1 and markers == [987654]
    else:
        assert not reaped and not signals and not markers
