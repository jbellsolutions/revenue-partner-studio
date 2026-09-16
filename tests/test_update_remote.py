import json
from pathlib import Path
import runpy

import pytest


def module():
    return runpy.run_path(str(Path(__file__).parents[1] / 'distribution/update-remote.py'))


def supervised(tmp_path, monkeypatch, saved_python=None, connector_argument=None):
    loaded = module()
    tmp_path.mkdir(parents=True, exist_ok=True)
    configuration = (tmp_path / 'connector.json').resolve()
    configuration.write_text(json.dumps({'computerId': 'test'}))
    python = (tmp_path / 'venv/bin/python').resolve()
    python.parent.mkdir(parents=True)
    python.write_text('')
    proc = tmp_path / 'proc'
    process = proc / '123'
    process.mkdir(parents=True)
    argument = connector_argument or str(configuration)
    (process / 'cmdline').write_bytes(
        ('\0'.join([str(python), '-m', 'studio.cloud_connector', '--config', argument]) + '\0').encode()
    )
    monkeypatch.setattr(loaded['subprocess'], 'check_output', lambda *args, **kwargs: '123')
    current = {} if saved_python is None else {'python': saved_python}
    return loaded['supervised_python'], configuration, current, proc, python


def test_legacy_update_resolves_python_from_exact_supervised_connector(tmp_path, monkeypatch):
    resolve, configuration, current, proc, python = supervised(tmp_path, monkeypatch)
    assert resolve(configuration, current, proc) == str(python)


def test_remote_update_refuses_another_connector_or_saved_interpreter(tmp_path, monkeypatch):
    resolve, configuration, current, proc, _ = supervised(
        tmp_path, monkeypatch, connector_argument=str(tmp_path / 'another.json')
    )
    with pytest.raises(ValueError, match='owner could not be verified'):
        resolve(configuration, current, proc)

    resolve, configuration, _, proc, _ = supervised(tmp_path / 'second', monkeypatch)
    with pytest.raises(ValueError, match='owner could not be verified'):
        resolve(configuration, {'python': '/another/python'}, proc)
