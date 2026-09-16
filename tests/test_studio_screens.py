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


def test_diagnostics_never_allocate_start_or_extend_a_lease(registry, monkeypatch):
    monkeypatch.setattr(screens, 'listening', lambda port: False)
    assert screens.inspect('brent')['state'] == 'unassigned'
    assert not (registry/'screens.json').exists()
    screens.screen('brent')
    before = (registry/'brent/leases.json').read_bytes()
    assert screens.inspect('brent')['state'] == 'starting'
    assert (registry/'brent/leases.json').read_bytes() == before
    assert not (registry/'brent/display.process.json').exists()


def test_capacity_cannot_exceed_host_qualification_and_does_not_count_head(registry):
    (registry/'screen-capacity.json').write_text(json.dumps({'requested': 8, 'qualified': 6}))
    screens.screen('default')
    for i in range(6): screens.screen('specialist-' + str(i))
    with pytest.raises(screens.ScreenBusy) as e: screens.screen('seventh')
    assert e.value.capacity == 6 and e.value.position == 1


def test_unverified_screen_process_is_reported_without_taking_ownership(registry, monkeypatch):
    screens.screen('brent')
    monkeypatch.setattr(screens, 'listening', lambda port: True)
    monkeypatch.setattr(screens.os, 'killpg', lambda *a: pytest.fail('diagnostics cannot stop a process'))
    result = screens.inspect('brent')
    assert result['state'] == 'repair_needed' and result['reason'] == 'unverified_owner'
    assert not (registry/'brent/display.process.json').exists()


def test_ownership_repair_preserves_live_services_browser_data_and_human_control(registry,monkeypatch):
    info=screens.screen('brent');directory=Path(info['directory'])
    screens.control('brent',True)
    browser=directory/'browser';browser.mkdir();(browser/'profile-proof').write_text('saved browser')
    leases=(directory/'leases.json').read_bytes();assignment=(registry/'screens.json').read_bytes()
    monkeypatch.setattr(screens,'port_owners',lambda port:{port})
    monkeypatch.setattr(screens,'listening',lambda port:True)
    monkeypatch.setattr(screens,'window_managers',lambda info:[])
    monkeypatch.setattr(screens,'managed_identity',lambda info,service,pid:{'pid':pid,'start':'verified'})
    monkeypatch.setattr(screens.os,'killpg',lambda *a:pytest.fail('repair must never stop live services'))
    result=screens.reconcile('brent')
    assert result['reconciled']==['chrome','display','viewer']
    assert (directory/'paused').exists() and (directory/'leases.json').read_bytes()==leases
    assert (registry/'screens.json').read_bytes()==assignment and (browser/'profile-proof').read_text()=='saved browser'
    assert json.loads((directory/'chrome.process.json').read_text())=={'pid':info['cdpPort'],'start':'verified'}


def test_ownership_repair_is_all_or_nothing_for_unknown_or_multiple_owners(registry,monkeypatch):
    info=screens.screen('brent');directory=Path(info['directory'])
    monkeypatch.setattr(screens,'port_owners',lambda port:{1,2} if port==info['cdpPort'] else {1})
    monkeypatch.setattr(screens,'listening',lambda port:True)
    monkeypatch.setattr(screens,'managed_identity',lambda *a:{'pid':1,'start':'verified'})
    with pytest.raises(RuntimeError,match='multiple owners'):screens.reconcile('brent')
    assert not list(directory.glob('*.process.json'))
    monkeypatch.setattr(screens,'port_owners',lambda port:{1})
    def unknown(*a):raise RuntimeError('unverified owner')
    monkeypatch.setattr(screens,'managed_identity',unknown)
    with pytest.raises(RuntimeError,match='unverified owner'):screens.reconcile('brent')
    assert not list(directory.glob('*.process.json'))


def test_repair_requires_browser_directory_display_port_and_own_process_group(registry,monkeypatch):
    info=screens.screen('brent');proc=registry/'proc';p=proc/'42';p.mkdir(parents=True)
    args=['/usr/bin/google-chrome','--remote-debugging-address=127.0.0.1',f"--remote-debugging-port={info['cdpPort']}",'--user-data-dir='+str(Path(info['directory'])/'browser')]
    (p/'cmdline').write_bytes(('\0'.join(args)+'\0').encode());(p/'environ').write_bytes(('DISPLAY='+info['display']+'\0').encode())
    monkeypatch.setattr(screens,'process_start',lambda pid:'verified')
    monkeypatch.setattr(screens.os,'getpgid',lambda pid:pid)
    assert screens.managed_identity(info,'chrome',42,proc)=={'pid':42,'start':'verified'}
    (p/'environ').write_bytes(b'DISPLAY=:99\0')
    with pytest.raises(RuntimeError,match='another display'):screens.managed_identity(info,'chrome',42,proc)
    (p/'environ').write_bytes(('DISPLAY='+info['display']+'\0').encode())
    args[-1]='--user-data-dir=/another/agent/browser';(p/'cmdline').write_bytes(('\0'.join(args)+'\0').encode())
    with pytest.raises(RuntimeError,match='unverified owner'):screens.managed_identity(info,'chrome',42,proc)
    monkeypatch.setattr(screens.os,'getpgid',lambda pid:1)
    with pytest.raises(RuntimeError,match='ownership'):screens.managed_identity(info,'chrome',42,proc)


def test_assignment_identity_changes_even_when_same_profile_reuses_same_slot(registry):
    first = screens.screen('researcher')
    assert screens.release('researcher')
    second = screens.screen('researcher')
    assert second['display'] == first['display']
    assert second['screenId'] != first['screenId']
    with pytest.raises(RuntimeError, match='assignment changed'):
        with screens.action(first):
            pytest.fail('a stale session must not control a reacquired slot')


def test_release_preserves_prewarmed_slot_and_private_browser_data(registry, monkeypatch):
    info = screens.screen('researcher')
    profile = Path(info['directory'])
    slot = Path(info['slotDirectory'])
    (profile/'browser').mkdir(); (profile/'browser'/'Cookies').write_text('private')
    for name, directory, pid in [('display', slot, 10), ('viewer', slot, 11), ('window-manager', slot, 12), ('chrome', profile, 13)]:
        (directory/(name+'.process.json')).write_text(json.dumps({'pid': pid, 'start': 'live'}))
    live = {info['vncPort'], info['wsPort'], info['cdpPort']}
    monkeypatch.setattr(screens, 'listening', lambda port: port in live)
    monkeypatch.setattr(screens, 'process_start', lambda pid: 'live')
    monkeypatch.setattr(screens, 'managed_identity', lambda _info, name, pid: {'pid': pid, 'start': 'live'})
    killed = []
    def stop(pid, _signal):
        killed.append(pid); live.discard(info['cdpPort'])
    monkeypatch.setattr(screens.os, 'killpg', stop)
    assert screens.release('researcher')
    assert killed == [13]
    assert info['vncPort'] in live and info['wsPort'] in live
    assert (profile/'browser'/'Cookies').read_text() == 'private'
    assert (slot/'display.process.json').exists() and (slot/'viewer.process.json').exists()


def test_prewarm_does_not_assign_agents_or_start_private_browsers(registry, monkeypatch):
    prepared = []
    monkeypatch.setattr(screens, '_ensure_slot', lambda info: prepared.append(info))
    result = screens.prewarm()
    assert result['prepared'] == 4 and result['failures'] == []
    assert {row['display'] for row in prepared} == {':100', ':101', ':102', ':103'}
    assert not (registry/'screens.json').exists()
    assert not list(registry.glob('slot-*/browser'))
