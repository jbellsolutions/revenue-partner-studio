"""Small, host-local screen manager for one Orgo computer.

The registry survives restarts; Xvnc/Chrome are started only when needed. All
listeners are loopback-only and reached through the desktop's existing SSH
connection. Profiles isolate work surfaces, not users or filesystem access.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import signal
import subprocess
import sys
import time
import urllib.request

PROFILE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$")
COMPUTER = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
SPECIALIST_DISPLAYS = range(100, 104)
MAX_SPECIALISTS = 16


def capacity():
    """Retain the four-slot baseline; extra slots require host qualification."""
    base = root()
    path = base / 'screen-capacity.json'
    value = json.loads(path.read_text()) if path.exists() else {}
    qualified = max(4, min(MAX_SPECIALISTS, int(value.get('qualified', 4))))
    requested = max(1, min(MAX_SPECIALISTS, int(value.get('requested', 4))))
    return {'specialists': min(requested, qualified), 'qualified': qualified,
            'qualification': 'host_verified' if value.get('qualified') else 'baseline',
            'requested': requested, 'headScreen': True}


def configure_capacity(profile, count):
    computer = verify_binding()
    if not PROFILE.fullmatch(profile): raise ValueError('Invalid agent profile')
    count = int(count)
    with locked(root() / 'registry.lock'):
        current = capacity()
        if not 1 <= count <= current['qualified']:
            raise ValueError('This screen count has not been qualified on this computer')
        path = root() / 'screen-capacity.json'
        value = json.loads(path.read_text()) if path.exists() else {}
        write_json(path, {**value, 'requested': count})
    return {'computerId': computer, 'profile': profile, 'capacity': capacity()}


class ScreenBusy(RuntimeError):
    def __init__(self, position):
        self.position = position
        self.capacity = capacity()['specialists']
        count = 'four' if self.capacity == 4 else str(self.capacity)
        super().__init__(f'All {count} specialist screens are assigned; queued at position {position}')


def queue_state(base):
    path = base / 'screen-queue.json'
    rows = json.loads(path.read_text()) if path.exists() else []
    return [r for r in rows if r['seen'] > time.time() - 120]


def lease(profile, owner, duration=30):
    if not PROFILE.fullmatch(profile) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', owner):
        raise ValueError('Invalid screen lease')
    verify_binding(); base = root()
    with locked(base / 'registry.lock'):
        path = base / 'screens.json'
        state = json.loads(path.read_text()) if path.exists() else {'default': 99}
        if profile not in state: return False
        directory = base / profile; directory.mkdir(mode=0o700, exist_ok=True)
        path = directory / 'leases.json'
        values = json.loads(path.read_text()) if path.exists() else {}
        values = {k: v for k, v in values.items() if v > time.time()}
        if duration: values[owner] = time.time() + min(duration, 60)
        else: values.pop(owner, None)
        write_json(path, values)
        return True


def cancel_wait(profile):
    verify_binding(); base = root()
    with locked(base / 'registry.lock'):
        write_json(base / 'screen-queue.json', [r for r in queue_state(base) if r['profile'] != profile])


def reclaim_idle():
    """Only reclaim on demand, after task/viewer leases and human control end."""
    base = root()
    with locked(base / 'registry.lock'):
        if not queue_state(base): return
        path = base / 'screens.json'
        names = list(json.loads(path.read_text())) if path.exists() else []
    for name in names:
        # An assignment made by an older runtime remains untouched until it has
        # participated in lease tracking. Never infer legacy work is idle.
        if name != 'default' and (base / name / 'leases.json').exists() and release(name): break


def root() -> Path:
    if sys.platform != "linux":
        raise RuntimeError("Computer tools must run on the Orgo Linux host, never the Mac")
    path = Path(os.environ.get("ORGO_CONTROL_ROOT", "/root/.hermes/orgo-computer"))
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    return path


@contextmanager
def locked(path: Path):
    with path.open("a+", encoding="utf-8") as f:
        os.chmod(path, 0o600)
        fcntl.flock(f, fcntl.LOCK_EX)
        yield


def write_json(path: Path, value) -> None:
    staging = path.with_suffix(".tmp")
    staging.write_text(json.dumps(value), encoding="utf-8")
    staging.chmod(0o600)
    staging.replace(path)


def verify_binding() -> str:
    expected = os.environ.get("ORGO_DEFAULT_COMPUTER_ID", "").lower()
    if not COMPUTER.fullmatch(expected):
        raise RuntimeError("A valid bound Orgo computer ID is required")
    path = root() / "computer.json"
    if not path.exists() or json.loads(path.read_text(encoding="utf-8")).get("computerId") != expected:
        raise RuntimeError("Cloud computer binding mismatch or missing; refusing to control another computer")
    return expected


def bind(computer_id: str) -> None:
    """Installer-only, write-once binding; changing computers requires a new install."""
    computer_id = computer_id.lower()
    if not COMPUTER.fullmatch(computer_id):
        raise ValueError("Invalid Orgo computer ID")
    base = root()
    with locked(base / "registry.lock"):
        path = base / "computer.json"
        if path.exists() and json.loads(path.read_text(encoding="utf-8")).get("computerId") != computer_id:
            raise RuntimeError("This installation is already bound to another computer")
        write_json(path, {"computerId": computer_id})


def _identities(base: Path) -> tuple[Path, dict]:
    path = base / 'screen-identities.json'
    return path, json.loads(path.read_text()) if path.exists() else {}


def _info(profile: str, display: int, computer_id: str) -> dict:
    base = root()
    directory = base / profile
    directory.mkdir(mode=0o700, exist_ok=True)
    slot = base / 'slots' / str(display)
    slot.mkdir(mode=0o700, parents=True, exist_ok=True)
    return {"profile": profile, "computerId": computer_id, "display": f":{display}",
            "vncPort": 5900 + display, "wsPort": 6100 + display,
            "cdpPort": 9300 + display, "directory": str(directory),
            "slotDirectory": str(slot)}


def _screen_id(base: Path, profile: str, display: int, *, create: bool) -> str | None:
    path, values = _identities(base)
    row = values.get(profile)
    if isinstance(row, dict) and row.get('display') == display and isinstance(row.get('screenId'), str):
        return row['screenId']
    if not create:
        return None
    value = secrets.token_hex(16)
    values[profile] = {'display': display, 'screenId': value, 'assigned': time.time()}
    write_json(path, values)
    return value


def screen(profile: str) -> dict:
    if not PROFILE.fullmatch(profile):
        raise ValueError("Invalid agent profile")
    computer_id = verify_binding()
    base = root()
    with locked(base / "registry.lock"):
        path = base / "screens.json"
        state = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"default": 99}
        if profile not in state:
            queue = queue_state(base)
            row = next((r for r in queue if r['profile'] == profile), None)
            if row: row['seen'] = time.time()
            else: queue.append({'profile': profile, 'seen': time.time()})
            free = sorted(set(range(100, 100 + capacity()['specialists'])) - set(state.values()))
            if not free or queue[0]['profile'] != profile:
                write_json(base / 'screen-queue.json', queue)
                raise ScreenBusy(next(i + 1 for i, r in enumerate(queue) if r['profile'] == profile))
            state[profile] = free[0]
            write_json(path, state)
            write_json(base / 'screen-queue.json', [r for r in queue if r['profile'] != profile])
            directory = base / profile
            directory.mkdir(mode=0o700, exist_ok=True)
            # The file marks assignments created by the lease-aware runtime;
            # an empty document reserves nothing and can be reclaimed at once.
            write_json(directory / 'leases.json', {})
        display = state[profile]
        screen_id = _screen_id(base, profile, display, create=True)
    return {**_info(profile, display, computer_id), 'screenId': screen_id}


def listening(port: int) -> bool:
    # A TCP connect/close is NOT a harmless VNC health probe: TigerVNC can
    # count incomplete handshakes toward its localhost authentication blacklist.
    # Inspect kernel listeners without creating a connection to the service.
    for table in (Path('/proc/net/tcp'), Path('/proc/net/tcp6')):
        if not table.exists():
            continue
        for row in table.read_text(encoding="utf-8").splitlines()[1:]:
            fields = row.split()
            if len(fields) > 3 and fields[3] == '0A' and int(fields[1].rsplit(':', 1)[1], 16) == port:
                return True
    return False


def _service_directory(info: dict, name: str) -> Path:
    return Path(info['slotDirectory'] if name in {'display', 'viewer', 'window-manager'} else info['directory'])


def _record_candidates(info: dict, name: str):
    primary = _service_directory(info, name) / (name + '.process.json')
    yield primary
    legacy = Path(info['directory']) / (name + '.process.json')
    if legacy != primary:
        yield legacy


def _verified_chrome_group(info: dict, value: dict, proc_root=Path('/proc')) -> dict | None:
    """Verify Chrome when its launcher remains the process-group owner.

    Some Chrome builds hand the debugging socket to a child and leave the
    recorded group leader with an empty command line. The immutable Linux start
    time still identifies our launcher; the socket owner must be a Chrome
    executable in that exact process group and on the assigned display.
    """
    try:
        leader = int(value['pid'])
        start = value['start']
        if process_start(leader) != start or not listening(info['cdpPort']):
            return None
        owners = port_owners(info['cdpPort'])
        if len(owners) != 1:
            return None
        owner = next(iter(owners))
        if os.getpgid(owner) != leader:
            return None
        executable = Path(os.readlink(proc_root / str(owner) / 'exe')).name
        if executable not in {'chrome', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'}:
            return None
        environment = (proc_root / str(owner) / 'environ').read_bytes().split(b'\0')
        if ('DISPLAY=' + info['display']).encode() not in environment:
            return None
        return {'pid': leader, 'start': start}
    except (KeyError, OSError, TypeError, ValueError):
        return None


def _verified_record(info: dict, name: str, *, promote: bool = True) -> dict | None:
    for record in _record_candidates(info, name):
        if not record.exists():
            continue
        value = {}
        try:
            value = json.loads(record.read_text())
            if value.get('start') and process_start(value.get('pid', 0)) == value['start']:
                identity = managed_identity(info, name, value['pid'])
                primary = _service_directory(info, name) / (name + '.process.json')
                if promote and record != primary:
                    write_json(primary, identity)
                return identity
        except (OSError, ValueError, RuntimeError, json.JSONDecodeError):
            # A Chrome launcher can exit after handing the port to its child,
            # leaving a stale or briefly empty /proc command. Treat the saved
            # record as unverified. Callers still refuse to reuse a listening
            # port, while a closed port can be safely reassigned.
            identity = _verified_chrome_group(info, value) if name == 'chrome' and isinstance(value, dict) else None
            if identity:
                return identity
            continue
    return None


def spawn(info: dict, name: str, command: list[str]) -> None:
    directory = _service_directory(info, name)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (directory / (name + ".log")).open("ab") as log:
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                         env={**os.environ, "DISPLAY": info["display"]}, start_new_session=True)
        write_json(directory / (name + ".process.json"),
                   {"pid": process.pid, "start": process_start(process.pid)})


def wait_port(port: int) -> None:
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        if listening(port):
            return
        time.sleep(0.1)
    raise RuntimeError(f"Cloud screen service did not start on port {port}")


def _ensure_slot(info: dict) -> None:
    profile = info['profile']
    for name, port in [('display', info['vncPort']), ('viewer', info['wsPort'])]:
        # The primary Orgo desktop predates this manager and remains owned by
        # the computer image. Specialist slots must always have an exact local
        # process identity before they can be reused.
        if profile != 'default' and listening(port) and not _verified_record(info, name):
            raise RuntimeError('This screen port has an unverified owner; it was preserved. Recover its assignment before continuing.')
    if not listening(info["vncPort"]):
        if profile == "default":
            raise RuntimeError("The Orgo primary desktop is unavailable; recover the computer")
        spawn(info, "display", ["Xvnc", info["display"], "-geometry", "1440x900", "-depth", "24",
            "-rfbport", str(info["vncPort"]), "-localhost", "-SecurityTypes", "VncAuth",
            "-PasswordFile", "/tmp/.vncpasswd", "-AlwaysShared", "-ac", "+render", "-noreset"])
        wait_port(info["vncPort"])
    managers = window_managers(info)
    if len(managers) > 1:
        raise RuntimeError('This screen has multiple window managers; it was preserved')
    if managers:
        write_json(Path(info['slotDirectory']) / 'window-manager.process.json', managers[0])
    elif profile != 'default':
        spawn(info, "window-manager", ["xfwm4", "--sm-client-disable"])
    if not listening(info["wsPort"]):
        spawn(info, "viewer", ["/usr/bin/websockify", f"127.0.0.1:{info['wsPort']}",
                               f"127.0.0.1:{info['vncPort']}"])
        wait_port(info["wsPort"])


def prewarm(profile: str = 'default') -> dict:
    """Prepare physical display/viewer slots without consuming an agent assignment."""
    if not PROFILE.fullmatch(profile):
        raise ValueError('Invalid agent profile')
    computer = verify_binding(); base = root()
    registry_path = base / 'screens.json'
    registry = json.loads(registry_path.read_text()) if registry_path.exists() else {'default': 99}
    by_display = {value: name for name, value in registry.items()}
    prepared, failures = [], []
    for display in range(100, 100 + capacity()['specialists']):
        owner = by_display.get(display, f'slot-{display}')
        info = _info(owner, display, computer)
        try:
            with locked(Path(info['slotDirectory']) / 'start.lock'):
                _ensure_slot(info)
            prepared.append(display)
        except Exception as exc:
            failures.append({'display': f':{display}', 'error': str(exc)[:250]})
    return {'computerId': computer, 'profile': profile, 'prepared': len(prepared),
            'capacity': capacity(), 'failures': failures}


def ensure(profile: str, *, browser: bool = False, owner: str | None = None) -> dict:
    try:
        info = screen(profile)
    except ScreenBusy:
        # screen() has recorded this request in the FIFO queue. Reclaim at most
        # one expired viewer-only assignment, then retry the same request. Task
        # and human-control leases remain protected by release().
        reclaim_idle()
        info = screen(profile)
    if owner:
        lease(profile, owner)
    directory = Path(info["directory"])
    start_guard = locked(Path(info['slotDirectory']) / "start.lock")
    with locked(root() / "registry.lock"):
        start_guard.__enter__()
        try:
            validate_assignment(info)
        except BaseException:
            start_guard.__exit__(*sys.exc_info())
            raise
    try:
        _ensure_slot(info)
        if browser:
            # The primary :99 desktop belongs to the Orgo image and predates
            # this manager. Specialist browsers always require our exact
            # profile-scoped process identity.
            if profile != 'default' and listening(info['cdpPort']) and not _verified_record(info, 'chrome'):
                raise RuntimeError('This screen browser has an unverified owner; it was preserved. Recover its assignment before continuing.')
            if not listening(info["cdpPort"]):
                spawn(info, "chrome", ["/usr/bin/google-chrome", "--no-sandbox", "--disable-dev-shm-usage",
                    "--no-first-run", "--no-default-browser-check", "--remote-debugging-address=127.0.0.1",
                    f"--remote-debugging-port={info['cdpPort']}",
                    f"--user-data-dir={directory / 'browser'}", "about:blank"])
                wait_port(info["cdpPort"])
            with urllib.request.urlopen(f"http://127.0.0.1:{info['cdpPort']}/json/version", timeout=3) as response:
                info['browserId'] = json.load(response).get("webSocketDebuggerUrl")
                if not info['browserId']:
                    raise RuntimeError("Cloud browser debugging endpoint is unhealthy")
    finally:
        start_guard.__exit__(None, None, None)
    return {**info, "paused": (directory / "paused").exists(), 'state': 'ready',
            'mode': 'visible', 'capacity': capacity()}


def process_start(pid: int) -> str | None:
    try:
        # comm can contain spaces or parentheses; fields after its final ')' start at #3.
        return Path(f"/proc/{pid}/stat").read_text().rsplit(')', 1)[1].split()[19]
    except (FileNotFoundError, ProcessLookupError):
        return None


def port_owners(port: int) -> set[int]:
    inodes = set()
    for table in (Path('/proc/net/tcp'), Path('/proc/net/tcp6')):
        if not table.exists(): continue
        for row in table.read_text().splitlines()[1:]:
            fields = row.split()
            if fields[3] == '0A' and int(fields[1].rsplit(':',1)[1],16) == port:
                inodes.add('socket:['+fields[9]+']')
    owners = set()
    if not inodes: return owners
    for process in Path('/proc').iterdir():
        if not process.name.isdigit(): continue
        try:
            if any(os.readlink(fd) in inodes for fd in (process/'fd').iterdir()): owners.add(int(process.name))
        except (FileNotFoundError, PermissionError, ProcessLookupError): continue
    return owners


def managed_identity(info: dict, service: str, pid: int, proc_root=Path('/proc')) -> dict:
    """Adopt only a process with this exact display, port and browser directory."""
    process = proc_root/str(pid)
    start = process_start(pid)
    if not start or os.getpgid(pid) != pid: raise RuntimeError('Screen process ownership could not be verified')
    args = process.joinpath('cmdline').read_bytes().decode().rstrip('\0').split('\0')
    if len(args) < 2: raise RuntimeError('Screen process command could not be verified')
    env = process.joinpath('environ').read_bytes().split(b'\0')
    if ('DISPLAY='+info['display']).encode() not in env:
        raise RuntimeError('The screen process belongs to another display')
    def option(name, value):
        return any(args[i:i+2] == [name,str(value)] for i in range(len(args)-1))
    valid = False
    if service == 'display':
        valid = Path(args[0]).name in {'Xvnc','Xtigervnc'} and args[1] == info['display'] and option('-rfbport',info['vncPort']) and '-localhost' in args and option('-PasswordFile','/tmp/.vncpasswd')
    elif service == 'viewer':
        valid = any(Path(arg).name == 'websockify' for arg in args[:2]) and args[-2:] == [f"127.0.0.1:{info['wsPort']}",f"127.0.0.1:{info['vncPort']}"]
    elif service == 'chrome':
        valid = Path(args[0]).name in {'google-chrome','chrome'} and f"--remote-debugging-port={info['cdpPort']}" in args and '--remote-debugging-address=127.0.0.1' in args and '--user-data-dir='+str(Path(info['directory'])/'browser') in args
    elif service == 'window-manager':
        valid = Path(args[0]).name == 'xfwm4' and '--sm-client-disable' in args
    if not valid or process_start(pid) != start: raise RuntimeError('An existing screen service has an unverified owner; it was preserved')
    return {'pid':pid, 'start':start}


def window_managers(info: dict) -> list[dict]:
    result = []
    for process in Path('/proc').iterdir():
        if not process.name.isdigit(): continue
        try:
            if process.joinpath('comm').read_text().strip() == 'xfwm4':
                result.append(managed_identity(info,'window-manager',int(process.name)))
        except (OSError,RuntimeError): continue
    return result


def reconcile(profile: str) -> dict:
    """Repair ownership records in place; never stop services or change a screen."""
    if not PROFILE.fullmatch(profile): raise ValueError('Invalid agent profile')
    computer = verify_binding(); base = root()
    with locked(base/'registry.lock'):
        registry_path = base/'screens.json'
        registry = json.loads(registry_path.read_text()) if registry_path.exists() else {'default':99}
        if profile == 'default' or profile not in registry:
            return {'computerId':computer,'profile':profile,'reconciled':[]}
        display = registry[profile]; directory = base/profile
        info = _info(profile, display, computer)
        with locked(Path(info['slotDirectory'])/'start.lock'), locked(directory/'action.lock'):
            identities = {}
            for service, key in [('display','vncPort'),('viewer','wsPort'),('chrome','cdpPort')]:
                saved = _verified_record(info, service, promote=False)
                if saved:
                    identities[service] = saved
                    continue
                owners = port_owners(info[key])
                if listening(info[key]) and not owners: raise RuntimeError('A live screen port owner could not be inspected; nothing was changed')
                if len(owners) > 1: raise RuntimeError('A screen port has multiple owners; nothing was changed')
                if owners: identities[service] = managed_identity(info,service,next(iter(owners)))
            managers = window_managers(info)
            if len(managers) > 1: raise RuntimeError('This screen has multiple window managers; nothing was changed')
            if managers: identities['window-manager'] = managers[0]
            for service, identity in identities.items():
                if managed_identity(info,service,identity['pid']) != identity:
                    raise RuntimeError('Screen ownership changed during repair; nothing was changed')
            backup = directory/'ownership-backups'/str(time.time_ns())
            backup.mkdir(mode=0o700,parents=True)
            write_json(backup/'assignment.json',{'computerId':computer,'profile':profile,'display':display})
            for service, identity in identities.items():
                record = _service_directory(info, service)/(service+'.process.json')
                if record.exists(): write_json(backup/record.name,json.loads(record.read_text()))
                write_json(record,identity)
    return {'computerId':computer,'profile':profile,'reconciled':sorted(identities),'backup':str(backup)}


def inspect(profile: str) -> dict:
    """Observe assignments without allocating, renewing, or starting a screen."""
    if not PROFILE.fullmatch(profile):
        raise ValueError('Invalid agent profile')
    computer = verify_binding()
    base = root()
    path = base / 'screens.json'
    registry = json.loads(path.read_text()) if path.exists() else {'default': 99}
    queue = queue_state(base)
    occupied = []
    for name, display in registry.items():
        directory = base / name
        leases = directory / 'leases.json'
        held = json.loads(leases.read_text()) if leases.exists() else {}
        occupied.append({'agentId': name, 'display': f':{display}',
                         'screenId': _screen_id(base, name, display, create=False),
                         'humanControl': (directory / 'paused').exists(),
                         'viewer': any(k.startswith('view-') and v > time.time() for k, v in held.items()),
                         'working': any(k.startswith('task-') and v > time.time() for k, v in held.items()),
                         'legacyOwnership': name != 'default' and not leases.exists()})
    result = {'computerId': computer, 'profile': profile, 'capacity': capacity(),
              'occupied': occupied, 'position': next((i + 1 for i, row in enumerate(queue) if row['profile'] == profile), None)}
    if profile not in registry:
        return {**result, 'state': 'waiting' if result['position'] else 'unassigned'}
    display = registry[profile]
    directory = base / profile
    info = _info(profile, display, computer)
    for service, offset in [('display', 5900), ('viewer', 6100), ('chrome', 9300)]:
        if profile != 'default' and listening(offset + display):
            if not _verified_record(info, service, promote=False):
                return {**result, 'state': 'repair_needed', 'reason': 'unverified_owner',
                        'message': 'An existing screen service has no verified owner. Its work has been preserved; repair requires ownership reconciliation.'}
    return {**result, 'display': f':{display}', 'paused': (directory / 'paused').exists(),
            'screenId': _screen_id(base, profile, display, create=False),
            'wsPort': 6100 + display, 'mode': 'visible',
            'state': 'ready' if listening(5900 + display) and listening(6100 + display) else 'starting'}


def validate_assignment(info: dict) -> None:
    path = root() / "screens.json"
    state = json.loads(path.read_text()) if path.exists() else {"default": 99}
    if state.get(info['profile']) != int(info['display'][1:]):
        raise RuntimeError("Screen assignment changed; reacquire this agent's screen")
    expected = info.get('screenId')
    current = _screen_id(root(), info['profile'], int(info['display'][1:]), create=False)
    if expected and current != expected:
        raise RuntimeError("Screen assignment changed; reacquire this agent's screen")


@contextmanager
def assigned_action(info: dict):
    directory = Path(info["directory"])
    # Acquire in registry -> action order, then let unrelated screens proceed.
    guard = locked(directory / "action.lock")
    with locked(root() / "registry.lock"):
        guard.__enter__()
        try:
            validate_assignment(info)
        except BaseException:
            guard.__exit__(*sys.exc_info())
            raise
    try:
        yield directory
    finally:
        guard.__exit__(None, None, None)


@contextmanager
def action(info: dict):
    with assigned_action(info) as directory:
        if (directory / "paused").exists():
            raise RuntimeError("Computer paused for human control; stop and wait for resume")
        yield


def control(profile: str, paused: bool) -> dict:
    info = screen(profile)
    with assigned_action(info) as directory:
        flag = directory / "paused"
        if paused:
            flag.touch(mode=0o600)
        else:
            flag.unlink(missing_ok=True)
    return {**info, "paused": paused}


def release(profile: str) -> bool:
    """Release an idle specialist's screen, preserving its files/browser profile.

    Only process groups created by this manager with matching Linux start times
    are stopped. A human-owned screen stays assigned until explicitly resumed.
    """
    if profile == 'default':
        return False
    if not PROFILE.fullmatch(profile):
        raise ValueError('Invalid agent profile')
    verify_binding()
    base = root()
    directory = base / profile
    with locked(base / 'registry.lock'):
        path = base / 'screens.json'
        state = json.loads(path.read_text()) if path.exists() else {'default': 99}
        if profile not in state:
            return True
        display = state[profile]
        info = _info(profile, display, verify_binding())
        with locked(Path(info['slotDirectory']) / 'start.lock'), locked(directory / 'action.lock'):
            if (directory / 'paused').exists():
                return False
            leases = directory / 'leases.json'
            held = json.loads(leases.read_text()) if leases.exists() else {}
            held = {key: value for key, value in held.items() if value > time.time()}
            if held:
                write_json(leases, held)
                return False
            # Keep the physical display, window manager and viewer prewarmed.
            # Only this profile's Chrome process is private to the assignment.
            record = directory / 'chrome.process.json'
            identity = _verified_record(info, 'chrome', promote=False)
            if listening(info['cdpPort']) and not identity:
                return False
            if identity:
                try:
                    os.killpg(identity['pid'], signal.SIGTERM)
                except ProcessLookupError:
                    pass
            deadline = time.monotonic() + 8
            while listening(info['cdpPort']):
                if time.monotonic() >= deadline:
                    # Keep ownership if Chrome remains. Never repurpose a live
                    # authenticated browser port.
                    return False
                time.sleep(.1)
            record.unlink(missing_ok=True)
            del state[profile]
            write_json(path, state)
            identity_path, identities = _identities(base)
            identities.pop(profile, None)
            write_json(identity_path, identities)
            leases.unlink(missing_ok=True)
            return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["status", "repair", "capacity", "prewarm", "ensure", "pause", "resume", "hold", "drop", "release", "cancel"])
    parser.add_argument("profile")
    parser.add_argument("owner", nargs='?', default='viewer')
    args = parser.parse_args()
    if args.operation == 'repair':
        result = reconcile(args.profile)
    elif args.operation == 'prewarm':
        result = prewarm(args.profile)
    elif args.operation == 'capacity':
        result = configure_capacity(args.profile, args.owner)
    elif args.operation in {'hold', 'drop'}:
        held = lease(args.profile, args.owner, 30 if args.operation == 'hold' else 0)
        released = release(args.profile) if args.operation == 'drop' else False
        result = {**(screen(args.profile) if held and args.operation == 'hold' else {}), 'held': held,
                  'released': released, 'computerId': verify_binding(), 'profile': args.profile}
    elif args.operation == 'release':
        result = {'released': release(args.profile), 'computerId': verify_binding(), 'profile': args.profile}
    elif args.operation == 'cancel':
        cancel_wait(args.profile)
        result = {'cancelled': True, 'computerId': verify_binding(), 'profile': args.profile}
    elif args.operation in {"pause", "resume"}:
        result = control(args.profile, args.operation == "pause")
    elif args.operation == "ensure":
        try: result = ensure(args.profile, browser=True, owner=args.owner)
        except ScreenBusy as exc:
            result = {'queued': True, 'position': exc.position, 'capacity': capacity(), 'computerId': verify_binding(), 'profile': args.profile}
    else:
        result = inspect(args.profile)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
