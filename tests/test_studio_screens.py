"""Ownership invariants; do not start desktops or touch a real computer."""
import json
from pathlib import Path
import pytest
from hermes_cli import orgo_screens as screens

@pytest.fixture
def registry(tmp_path, monkeypatch):
    monkeypatch.setattr(screens, 'root', lambda: tmp_path)
    monkeypatch.setattr(screens, 'verify_binding', lambda: 'dedicated-test')
    return tmp_path


def test_four_slots_and_release_reassigns_without_reusing_stale_identity(registry):
    head = screens.screen('default')
    first = screens.screen('researcher')
    screens.screen('writer'); screens.screen('builder'); screens.screen('fourth')
    with pytest.raises(RuntimeError, match='All four'):
        screens.screen('reviewer')
    screens.lease('researcher', 'reservation', 0)
    assert screens.release('researcher')
    replacement = screens.screen('reviewer')
    assert replacement['display'] == first['display']
    with pytest.raises(RuntimeError, match='assignment changed'):
        with screens.action(first):
            pytest.fail('stale identity may never operate the replacement screen')
    assert screens.screen('default') == head


def test_human_takeover_prevents_actions_and_screen_reassignment(registry):
    info = screens.screen('researcher')
    screens.control('researcher', True)
    with pytest.raises(RuntimeError, match='paused'):
        with screens.action(info):
            pytest.fail('agent action during human takeover')
    assert screens.release('researcher') is False
    screens.control('researcher', False)
    screens.lease('researcher', 'reservation', 0)
    assert screens.release('researcher') is True


def test_live_port_prevents_reassignment_and_pid_reuse_never_killed(registry, monkeypatch):
    info = screens.screen('researcher')
    screens.lease('researcher', 'reservation', 0)
    Path(info['directory'], 'display.process.json').write_text(json.dumps({'pid': 42, 'start': 'old'}))
    monkeypatch.setattr(screens, 'process_start', lambda pid: 'new')
    monkeypatch.setattr(screens.os, 'killpg', lambda *a: pytest.fail('must not kill reused PID'))
    monkeypatch.setattr(screens, 'listening', lambda port: True)
    ticks = iter([0, 20])
    monkeypatch.setattr(screens.time, 'monotonic', lambda: next(ticks))
    assert screens.release('researcher') is False
    assert screens.screen('researcher')['display'] == info['display']


def test_four_specialists_fifo_wait_cancel_and_viewer_task_leases(registry):
    first=screens.screen('a'); screens.screen('b'); screens.screen('c'); screens.screen('d')
    assert len({screens.screen(p)['display'] for p in ('a','b','c','d')})==4
    with pytest.raises(screens.ScreenBusy) as fifth:screens.screen('fifth')
    assert fifth.value.position==1
    with pytest.raises(screens.ScreenBusy) as sixth:screens.screen('sixth')
    assert sixth.value.position==2
    screens.lease('a','reservation',0);screens.lease('a','view-one');screens.lease('a','task-one')
    assert not screens.release('a')
    screens.lease('a','view-one',0);assert not screens.release('a')
    screens.lease('a','task-one',0);assert screens.release('a')
    with pytest.raises(screens.ScreenBusy):screens.screen('sixth')
    screens.cancel_wait('fifth')
    assert screens.screen('sixth')['display']==first['display']


def test_expired_viewer_lease_allows_reclaim_but_human_control_does_not(registry,monkeypatch):
    clock=[1000.0];monkeypatch.setattr(screens.time,'time',lambda:clock[0])
    for p in ('a','b','c','d'):screens.screen(p)
    screens.control('b',True)
    with pytest.raises(screens.ScreenBusy):screens.screen('waiting')
    clock[0]+=35
    screens.reclaim_idle()
    state=json.loads((registry/'screens.json').read_text())
    assert 'a' not in state and 'b' in state
    assert screens.screen('waiting')['display']==':100'
