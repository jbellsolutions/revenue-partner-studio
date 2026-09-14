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
import signal
import subprocess
import sys
import time
import urllib.request

PROFILE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$")
COMPUTER = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
SPECIALIST_DISPLAYS = range(100, 104)


class ScreenBusy(RuntimeError):
    def __init__(self, position):
        self.position = position
        super().__init__(f'All four specialist screens are assigned; queued at position {position}')


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


def write_json(path: Path, value: dict) -> None:
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
            free = sorted(set(SPECIALIST_DISPLAYS) - set(state.values()))
            if not free or queue[0]['profile'] != profile:
                write_json(base / 'screen-queue.json', queue)
                raise ScreenBusy(next(i + 1 for i, r in enumerate(queue) if r['profile'] == profile))
            state[profile] = free[0]
            write_json(path, state)
            write_json(base / 'screen-queue.json', [r for r in queue if r['profile'] != profile])
            directory = base / profile; directory.mkdir(mode=0o700, exist_ok=True)
            write_json(directory / 'leases.json', {'reservation': time.time() + 30})
        display = state[profile]
    directory = base / profile
    directory.mkdir(mode=0o700, exist_ok=True)
    return {"profile": profile, "computerId": computer_id, "display": f":{display}", "vncPort": 5900 + display,
            "wsPort": 6100 + display, "cdpPort": 9300 + display, "directory": str(directory)}


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


def spawn(info: dict, name: str, command: list[str]) -> None:
    with (Path(info["directory"]) / (name + ".log")).open("ab") as log:
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                         env={**os.environ, "DISPLAY": info["display"]}, start_new_session=True)
        write_json(Path(info["directory"]) / (name + ".process.json"),
                   {"pid": process.pid, "start": process_start(process.pid)})


def wait_port(port: int) -> None:
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        if listening(port):
            return
        time.sleep(0.1)
    raise RuntimeError(f"Cloud screen service did not start on port {port}")


def ensure(profile: str, *, browser: bool = False) -> dict:
    info = screen(profile)
    lease(profile, 'reservation')
    directory = Path(info["directory"])
    start_guard = locked(directory / "start.lock")
    with locked(root() / "registry.lock"):
        start_guard.__enter__()
        try:
            validate_assignment(info)
        except BaseException:
            start_guard.__exit__(*sys.exc_info())
            raise
    try:
        if profile != 'default':
            for name, port in [('display', info['vncPort']), ('viewer', info['wsPort']), ('chrome', info['cdpPort'])]:
                if listening(port):
                    record = directory / (name + '.process.json')
                    identity = json.loads(record.read_text()) if record.exists() else {}
                    if not identity.get('start') or process_start(identity.get('pid', 0)) != identity['start']:
                        raise RuntimeError('This screen port has an unverified owner; it was preserved. Recover its assignment before continuing.')
        if not listening(info["vncPort"]):
            if profile == "default":
                raise RuntimeError("The Orgo primary desktop is unavailable; recover the computer")
            spawn(info, "display", ["Xvnc", info["display"], "-geometry", "1440x900", "-depth", "24",
                "-rfbport", str(info["vncPort"]), "-localhost", "-SecurityTypes", "VncAuth",
                "-PasswordFile", "/tmp/.vncpasswd", "-AlwaysShared", "-ac", "+render", "-noreset"])
            wait_port(info["vncPort"])
            spawn(info, "window-manager", ["xfwm4", "--sm-client-disable"])
        if not listening(info["wsPort"]):
            spawn(info, "viewer", ["/usr/bin/websockify", f"127.0.0.1:{info['wsPort']}",
                                   f"127.0.0.1:{info['vncPort']}"])
            wait_port(info["wsPort"])
        if browser:
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
    return {**info, "paused": (directory / "paused").exists()}


def process_start(pid: int) -> str | None:
    try:
        # comm can contain spaces or parentheses; fields after its final ')' start at #3.
        return Path(f"/proc/{pid}/stat").read_text().rsplit(')', 1)[1].split()[19]
    except (FileNotFoundError, ProcessLookupError):
        return None


def validate_assignment(info: dict) -> None:
    path = root() / "screens.json"
    state = json.loads(path.read_text()) if path.exists() else {"default": 99}
    if state.get(info['profile']) != int(info['display'][1:]):
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
        with locked(directory / 'start.lock'), locked(directory / 'action.lock'):
            if (directory / 'paused').exists():
                return False
            leases = directory / 'leases.json'
            if leases.exists() and any(v > time.time() for v in json.loads(leases.read_text()).values()):
                return False
            for name in ('viewer', 'chrome', 'window-manager', 'display'):
                record = directory / (name + '.process.json')
                if not record.exists():
                    continue
                identity = json.loads(record.read_text())
                pid = identity['pid']
                if identity.get('start') and process_start(pid) == identity['start']:
                    try:
                        os.killpg(pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
            deadline = time.monotonic() + 8
            while any(listening(offset + display) for offset in (5900, 6100, 9300)):
                if time.monotonic() >= deadline:
                    # Keep ownership if anything remains. Never repurpose a live port.
                    return False
                time.sleep(.1)
            del state[profile]
            write_json(path, state)
            return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["status", "ensure", "pause", "resume", "hold", "drop", "cancel"])
    parser.add_argument("profile")
    parser.add_argument("owner", nargs='?', default='viewer')
    args = parser.parse_args()
    if args.operation in {'hold', 'drop'}:
        held = lease(args.profile, args.owner, 30 if args.operation == 'hold' else 0)
        result = {**(screen(args.profile) if held and args.operation == 'hold' else {}), 'held': held, 'computerId': verify_binding(), 'profile': args.profile}
    elif args.operation == 'cancel':
        cancel_wait(args.profile)
        result = {'cancelled': True, 'computerId': verify_binding(), 'profile': args.profile}
    elif args.operation in {"pause", "resume"}:
        result = control(args.profile, args.operation == "pause")
    elif args.operation == "ensure":
        try: result = ensure(args.profile)
        except ScreenBusy as exc:
            result = {'queued': True, 'position': exc.position, 'computerId': verify_binding(), 'profile': args.profile}
    else:
        result = screen(args.profile)
        result["paused"] = (Path(result["directory"]) / "paused").exists()
    print(json.dumps(result))


if __name__ == "__main__":
    main()
