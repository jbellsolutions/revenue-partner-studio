"""Explicit live cloud canary: a real Desktop-source Hermes chat, no Mac tools.

Uses the profile's existing model (and its existing billing). Computer work must
delegate to the separately subscription-authenticated Luna worker. Saves a normal
history thread. Only the temporary gateway this process starts is terminated.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

from websockets.sync.client import connect


def main():
    # This canary launches real automation against /root/.hermes on Orgo.
    # Refuse other platforms before opening files or starting any process.
    if sys.platform != 'linux':
        raise RuntimeError('Run this canary on the Orgo Linux host, never the Mac or Windows')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', choices=['default', 'team-support'], required=True)
    parser.add_argument('--task', required=True)
    args = parser.parse_args()
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    token = secrets.token_urlsafe(32)
    home = '/root/.hermes' if args.profile == 'default' else '/root/.hermes/profiles/' + args.profile
    runtime = Path(__file__).resolve().parents[1]
    env = {**os.environ, 'HERMES_HOME': home, 'PYTHONPATH': str(runtime),
           'HERMES_DASHBOARD_SESSION_TOKEN': token}
    log = tempfile.NamedTemporaryFile(prefix='orgo-chat-canary-', suffix='.log', delete=False)
    os.chmod(log.name, 0o600)
    command = [str(runtime / '.venv/bin/python'), '-m', 'hermes_cli.main']
    if args.profile != 'default': command += ['--profile', args.profile]
    command += ['serve', '--isolated', '--host', '127.0.0.1', '--port', str(port)]
    process = subprocess.Popen(command, env=env, cwd=runtime, stdout=log, stderr=log, start_new_session=True)
    try:
        for _ in range(90):
            if process.poll() is not None: raise RuntimeError(f'Canary gateway exited; inspect {log.name}')
            try:
                request = urllib.request.Request(f'http://127.0.0.1:{port}/api/health', headers={'X-Hermes-Session-Token': token})
                with urllib.request.urlopen(request, timeout=1): break
            except Exception: time.sleep(1)
        with connect(f'ws://127.0.0.1:{port}/api/ws?token={token}', open_timeout=10, max_size=None,
                     additional_headers={'Origin': f'http://127.0.0.1:{port}'}) as ws:
            serial = 0
            def rpc(method, params):
                nonlocal serial
                serial += 1
                ws.send(json.dumps({'jsonrpc': '2.0', 'id': str(serial), 'method': method, 'params': params}))
                while True:
                    event = json.loads(ws.recv(timeout=90))
                    if event.get('id') == str(serial):
                        if 'error' in event: raise RuntimeError(str(event['error']))
                        return event.get('result', {})
            created = rpc('session.create', {'source': 'desktop', 'cols': 100})
            sid = created.get('session_id') or created.get('id')
            if not sid: raise RuntimeError('No canary session ID')
            started = time.monotonic()
            rpc('prompt.submit', {'session_id': sid, 'text': args.task})
            results = []
            while time.monotonic() - started < 240:
                event = json.loads(ws.recv(timeout=245))
                if event.get('method') != 'event': continue
                params = event.get('params', {})
                kind = params.get('type', '')
                if kind in ('tool.start', 'tool.complete', 'message.complete', 'error'):
                    results.append(params)
                if kind == 'message.complete':
                    print(json.dumps({'profile': args.profile, 'sessionId': sid,
                                      'elapsedSeconds': round(time.monotonic()-started, 2),
                                      'events': results, 'log': log.name}))
                    return
            raise RuntimeError('Canary chat timed out')
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)  # windows-footgun: ok — Linux-only guard above
            try: process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)  # windows-footgun: ok — Linux-only guard above
                process.wait()
        log.close()


if __name__ == '__main__':
    main()
