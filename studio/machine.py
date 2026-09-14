"""Computer identity independent of display names and host platform."""
import json
import os
from pathlib import Path
import uuid

def kind():return os.environ.get('STUDIO_COMPUTER_KIND','orgo')
def computer_id():
    if kind()=='local':
        from hermes_constants import get_hermes_home
        record=Path(get_hermes_home())/'studio-cloud/local-computer.json'
        value=json.loads(record.read_text())
        identity=str(uuid.UUID(value['computerId']))
        if identity!=os.environ.get('STUDIO_COMPUTER_ID'):raise ValueError('Local Hermes computer identity mismatch.')
        return identity
    from hermes_cli.orgo_screens import verify_binding
    return verify_binding()
def workdir():return str(Path.home()/'studio-projects')
