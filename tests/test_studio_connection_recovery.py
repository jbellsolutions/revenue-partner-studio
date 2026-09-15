import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import uuid

spec = importlib.util.spec_from_file_location('studio_connector_recovery', Path(__file__).parents[1] / 'distribution/recover.py')
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)
A = '10000000-0000-4000-8000-000000000001'
ORIGIN = 'https://studio.test'


def test_repair_receipt_prevents_repeating_an_uncertain_start(tmp_path, monkeypatch):
    (tmp_path / 'studio-cloud').mkdir()
    monkeypatch.setattr(recovery, 'inspect', lambda *args: {'computerId': A, 'protocol': 1, 'code': 'connector_failed'})
    calls = []
    def start(args):
        calls.append(args)
        raise recovery.subprocess.TimeoutExpired(args, 12)
    monkeypatch.setattr(recovery, 'run', start)
    request = {'computerId': A, 'origin': ORIGIN, 'action': 'repair', 'requestId': str(uuid.uuid4())}
    first = recovery.dispatch(request, tmp_path)
    second = recovery.dispatch(request, tmp_path)
    assert first['code'] == second['code'] == 'repair_uncertain'
    assert second['replayed'] is True
    assert calls == [['supervisorctl', 'start', 'unified-studio-connector']]


def test_remote_attempt_limit_and_unsafe_states(tmp_path, monkeypatch):
    (tmp_path / 'studio-cloud').mkdir()
    current = {'computerId': A, 'protocol': 1, 'code': 'connector_failed'}
    monkeypatch.setattr(recovery, 'inspect', lambda *args: current.copy())
    calls = []
    monkeypatch.setattr(recovery, 'run', lambda args: calls.append(args) or SimpleNamespace(returncode=0))
    request = {'computerId': A, 'origin': ORIGIN, 'action': 'repair'}
    for _ in range(3): result = recovery.dispatch({**request, 'requestId': str(uuid.uuid4())}, tmp_path)
    assert result['code'] == 'attempt_limit'
    assert len(calls) == 2
    for code in ['paused', 'ownership_unknown', 'runtime_unavailable', 'not_installed']:
        current['code'] = code
        assert recovery.dispatch({**request, 'requestId': str(uuid.uuid4())}, tmp_path)['code'] == code
    assert len(calls) == 2


def test_inspection_checks_binding_service_ownership_and_deliberate_stop(tmp_path, monkeypatch):
    state = tmp_path / 'studio-cloud';state.mkdir()
    binding = tmp_path / 'orgo-computer';binding.mkdir()
    (binding / 'computer.json').write_text(json.dumps({'computerId': A}))
    config = {'computerId': A, 'cloudUrl': ORIGIN, 'hermesHome': str(tmp_path), 'stateDir': str(state / 'connector'),
              'python': '/verified/python', 'hermesUrl': 'http://127.0.0.1:8790', 'hermesTokenFile': str(state / 'token')}
    (state / 'connector.json').write_text(json.dumps(config));(state / 'token').write_text('fixture')
    conf = tmp_path / 'supervisor.conf'
    conf.write_text(f'[program:unified-studio-connector]\ncommand=/verified/python -m studio.cloud_connector --config {state}/connector.json\n[program:unified-studio-runtime]\ncommand={state}/serve\n')
    status = ['STOPPED']
    monkeypatch.setattr(recovery, 'run', lambda args: SimpleNamespace(stdout=f'unified-studio-connector {status[0]}\nunified-studio-runtime RUNNING\n'))
    class Response:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def read(self): return b'{"ok":true}'
    monkeypatch.setattr(recovery.urllib.request, 'urlopen', lambda *args, **kw: Response())
    assert recovery.inspect(A, ORIGIN, tmp_path, conf)['code'] == 'paused'
    status[0] = 'RUNNING'
    assert recovery.inspect(A, ORIGIN, tmp_path, conf)['code'] == 'connector_running'
    assert recovery.inspect(A, 'https://different.test', tmp_path, conf)['code'] == 'ownership_unknown'
    conf.write_text(conf.read_text().replace('/verified/python', '/unrelated/python'))
    assert recovery.inspect(A, ORIGIN, tmp_path, conf)['code'] == 'ownership_unknown'
