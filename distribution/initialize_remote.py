"""Fresh-home initialization; authentication is intentionally not imported."""
import os
from pathlib import Path
import secrets
import sys
import uuid
import yaml


def initialize(home: Path, computer_id: str):
    computer_id=str(uuid.UUID(computer_id))
    if any((home/name).exists() for name in ('config.yaml','auth.json','state.db','studio','profiles','orgo-computer')):
        raise RuntimeError('Existing Hermes data found; initialization refuses to overwrite it')
    home.mkdir(parents=True,exist_ok=True,mode=0o700)
    os.chmod(home,0o700)
    def write(path,text):
        with path.open('x') as file:file.write(text)
        path.chmod(0o600)
    # Select a subscription provider without creating credentials or invoking it.
    # The installing owner can change this through Hermes' own provider setup.
    grants=['terminal','file','web','studio','orgo-screen']
    config={'model':{'provider':'openai-codex','default':'gpt-5.6-luna'},
            'terminal':{'backend':'local','cwd':'/root/studio-projects'},
            'tools':{'enabled_toolsets':grants},
            'platform_toolsets':{'cli':grants,'desktop':grants},
            'browser':{'allow_private_urls':True}}
    write(home/'config.yaml',yaml.safe_dump(config))
    write(home/'.env','ORGO_DEFAULT_COMPUTER_ID='+computer_id+'\nBROWSER_BACKEND=local\nPATH=/opt/hermes-orgo-studio/computer-tools/node_modules/.bin:/usr/local/bin:/usr/bin:/bin\n')
    (home/'studio').mkdir(mode=0o700)
    write(home/'studio/gateway-token',secrets.token_urlsafe(48)+'\n')
    (home/'orgo-computer').mkdir(mode=0o700)
    import json
    write(home/'orgo-computer/computer.json',json.dumps({'computerId':computer_id})+'\n')
    write(home/'SOUL.md', 'You are the Head of Operations for this remote Hermes Studio workspace. '
          'Start projects by creating the named persistent specialists you need using studio_team. '
          'Use groups, explicit assignments, findings and revision requests. Each specialist must execute its own work. '
          'Never invent another agent’s response or claim a task passed without inspecting its evidence. '
          'Use orgo-screen tools for visible browser and computer work. '
          'Share project files only through /root/studio-projects; keep agent histories private. '
          'Stop for required permissions. Do not purchase capacity or switch to paid providers automatically.\n')
    return {'computerId':computer_id,'agents':1,'providerAuthenticated':False}

if __name__=='__main__':
    if sys.platform!='linux':raise SystemExit('Remote initialization requires Linux')
    print(initialize(Path('/root/.hermes'),sys.argv[1]))
    Path('/root/studio-projects').mkdir(mode=0o700,exist_ok=True)
