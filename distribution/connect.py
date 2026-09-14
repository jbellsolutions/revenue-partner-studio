"""Private, resumable Orgo connector bootstrap. Invoked by the owner setup wizard."""
from pathlib import Path
import base64
import fcntl
import hashlib
import json
import os
import secrets
import shutil
import socket
import sqlite3
import subprocess
import sys
import tarfile
import time
import urllib.request
import uuid


def write(path, value, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = path.with_name(path.name + '.new')
    with temp.open('w') as f:
        os.fchmod(f.fileno(), mode)
        f.write(value)
        f.flush()
        os.fsync(f.fileno())
    temp.replace(path)


def install(config_path):
    config_path = Path(config_path)
    config = json.loads(config_path.read_text())
    computer = str(uuid.UUID(config['computerId']))
    base = config_path.parent
    lock = (base / 'install.lock').open('a+')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return
    def status(state, detail):
        write(base / 'status.json', json.dumps({'state': state, 'detail': detail, 'updated': time.time()}))
    def run(args, **kw):
        return subprocess.run(args, check=True, stdin=subprocess.DEVNULL, **kw)
    home = Path('/root/.hermes')
    state = home / 'studio-cloud'
    phase = 'Checking computer compatibility'
    try:
        status('installing', phase)
        if sys.platform != 'linux' or os.geteuid() != 0:
            raise ValueError('Setup requires the selected Orgo Linux computer.')
        if not shutil.which('supervisorctl'):
            raise ValueError('The computer needs Supervisor before Studio can connect.')
        binding = home / 'orgo-computer/computer.json'
        if binding.exists() and json.loads(binding.read_text()).get('computerId') != computer:
            raise ValueError('Existing Hermes belongs to a different computer. No binding was changed.')
        # Exchange early, before dependency installation. Save the credential so
        # interrupted installation never needs to redeem the same code again.
        if not config.get('token'):
            req = urllib.request.Request(config['pairUrl'], data=json.dumps({'computerId':computer,'code':config['pair'],'platform':'linux'}).encode(), headers={'Content-Type':'application/json','Origin':config['origin']})
            with urllib.request.urlopen(req, timeout=30) as response:
                paired = json.load(response)
            if paired.get('computerId') != computer:
                raise ValueError('The pairing response identifies another computer.')
            config['token'] = paired['token']
            write(config_path, json.dumps(config))
        existing = state / 'connector.json'
        if existing.exists() and Path('/etc/supervisor/conf.d/unified-studio.conf').exists():
            current = json.loads(existing.read_text())
            if current.get('computerId') != computer or current.get('cloudUrl') != config['origin']:
                raise ValueError('A different Studio installation already owns this computer.')
            write(Path(current['connectorTokenFile']), config['token'])
            run(['supervisorctl','reread'])
            run(['supervisorctl','update','unified-studio-runtime','unified-studio-connector'])
            run(['supervisorctl','restart','unified-studio-connector'])
            status('waiting_for_connector','Connector repaired. Waiting for its authenticated connection.')
            return
        phase = 'Downloading and checking the pinned Studio runtime'
        status('installing', phase)
        archive = base / 'runtime.tar.gz'
        def checksum(path):
            digest=hashlib.sha256()
            with path.open('rb') as data:
                for chunk in iter(lambda:data.read(1024*1024),b''):digest.update(chunk)
            return digest.hexdigest()
        if not archive.exists() or checksum(archive) != config['sha256']:
            with urllib.request.urlopen(config['artifactUrl'], timeout=60) as response, archive.open('wb') as out:
                os.fchmod(out.fileno(), 0o600)
                shutil.copyfileobj(response,out)
        if checksum(archive) != config['sha256']:
            raise ValueError('The installation package checksum did not match.')
        source = Path('/opt/unified-studio-' + config['sha256'][:16])
        if not (source / '.verified').exists():
            source.mkdir(mode=0o755,exist_ok=True)
            with tarfile.open(archive) as tar:
                for item in tar.getmembers():
                    path=Path(item.name)
                    if path.is_absolute() or '..' in path.parts or not (item.isfile() or item.isdir()):raise ValueError('Unsafe runtime archive.')
                tar.extractall(source)
            write(source / '.verified',config['sha256'])
        phase = 'Checking Python and native Hermes compatibility'
        status('installing',phase)
        candidates = [Path('/usr/local/lib/hermes-agent/venv/bin/python'),Path('/opt/hermes-orgo-studio/venv/bin/python')]
        candidates += sorted((home/'desktop-runtime').glob('*/.venv/bin/python'),reverse=True)
        env = {**os.environ,'PYTHONPATH':str(source),'HERMES_HOME':str(home)}
        probe = 'import studio.cloud_connector,studio.cloud_profiles,studio.cloud_files,hermes_cli.web_server,tui_gateway.server'
        python = next((p for p in candidates if p.exists() and subprocess.run([str(p),'-c',probe],env=env,cwd=source,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=60).returncode==0),None)
        if not python:
            if shutil.disk_usage(source).free < 2*1024**3:
                raise ValueError('The computer needs at least 2 GB free to install its Python runtime.')
            run(['/usr/bin/python3','-m','venv',str(source/'bootstrap-venv')])
            run([str(source/'bootstrap-venv/bin/pip'),'install','--disable-pip-version-check','uv==0.12.7'])
            run([str(source/'bootstrap-venv/bin/uv'),'sync','--frozen','--python','3.11','--extra','mcp','--extra','anthropic','--no-dev'],cwd=source,env={**env,'UV_PROJECT_ENVIRONMENT':str(source/'venv')})
            python = source/'venv/bin/python'
            run([str(python),'-c',probe],env=env,cwd=source)
        phase = 'Backing up and verifying existing Hermes data'
        status('installing',phase)
        backup = base/'backup'
        if not (backup/'complete.json').exists():
            roots = [home]+[p for p in (home/'profiles').glob('*') if p.is_dir() and not p.is_symlink()]
            databases = [(root,file) for root in roots for file in root.glob('*.db') if not file.is_symlink()]
            needed = sum(f.stat().st_size for _,f in databases)+512*1024**2
            if shutil.disk_usage(home).free < needed:
                raise ValueError('A verified external backup is needed: this computer lacks room for a local database snapshot. No Hermes data was changed.')
            for root in roots:
                destination=backup/('default' if root==home else root.name)
                destination.mkdir(parents=True,exist_ok=True,mode=0o700)
                for name in ['config.yaml','profile.yaml','auth.json','.env','SOUL.md','AGENTS.md','MEMORY.md','USER.md']:
                    file=root/name
                    if file.is_file() and not file.is_symlink():
                        shutil.copy2(file,destination/name);(destination/name).chmod(0o600)
            for root,file in databases:
                target=backup/('default' if root==home else root.name)/file.name
                with sqlite3.connect(file.as_uri()+'?mode=ro',uri=True) as src, sqlite3.connect(target) as dst:
                    src.backup(dst)
                    if dst.execute('PRAGMA integrity_check').fetchone()[0]!='ok':
                        raise ValueError('An existing database backup failed verification. No Hermes data was changed.')
                target.chmod(0o600)
            shutil.copytree('/etc/supervisor/conf.d',backup/'supervisor',dirs_exist_ok=True)
            write(backup/'complete.json',json.dumps({'computerId':computer,'databases':len(databases),'created':time.time()}))
        # Initialize only a truly fresh Hermes home. Existing config and provider
        # credentials are retained byte-for-byte.
        if not (home/'config.yaml').exists():
            run([str(python),str(source/'distribution/initialize_remote.py'),computer],cwd=source,env=env)
        if not binding.exists():
            run([str(python),'-c','from hermes_cli.orgo_screens import bind;bind('+repr(computer)+')'],cwd=source,env=env)
        phase='Preparing the isolated Studio service'
        status('installing',phase)
        for port in range(8790,8800):
            with socket.socket() as sock:
                if sock.connect_ex(('127.0.0.1',port))!=0:break
        else:raise ValueError('Studio needs an available local service port between 8790 and 8799.')
        write(state/'gateway-token',secrets.token_urlsafe(48))
        write(state/'connector-token',config['token'])
        runtime_env={'HERMES_HOME':str(home),'HERMES_STUDIO_RUNTIME':'1','HERMES_DESKTOP':'1','HERMES_STUDIO_STATE_DIR':str(state/'runtime'),'PYTHONPATH':str(source),'ORGO_DEFAULT_COMPUTER_ID':computer}
        serve="#!/usr/bin/python3\nimport os\nfrom pathlib import Path\nos.environ.update("+repr(runtime_env)+")\nos.environ['HERMES_DASHBOARD_SESSION_TOKEN']=Path("+repr(str(state/'gateway-token'))+").read_text().strip()\nos.chdir("+repr(str(source))+")\nos.execv("+repr(str(python))+","+repr([str(python),'-m','hermes_cli.main','serve','--isolated','--host','127.0.0.1','--port',str(port)])+")\n"
        write(state/'serve',serve,0o700)
        screen = source/'distribution/screen-control.py'
        screen_ready = Path('/tmp/.vncpasswd').exists() and any(shutil.which(x) for x in ['Xvnc','Xtigervnc'])
        if screen_ready:
            tools=source/'distribution/computer-tools'
            if not (tools/'node_modules/.bin/agent-browser').exists():run(['npm','ci','--ignore-scripts','--prefix',str(tools)],cwd=source)
        current={'computerId':computer,'kind':'orgo','cloudUrl':config['origin'],'hermesHome':str(home),'stateDir':str(state/'connector'),'hermesUrl':f'http://127.0.0.1:{port}','hermesOrigin':f'http://127.0.0.1:{port}','hermesTokenFile':str(state/'gateway-token'),'connectorTokenFile':str(state/'connector-token'),'sourceDir':str(source),'python':str(python),'screenControl':str(state/'screen-control') if screen_ready else '', 'screenPasswordFile':str(state/'vnc-password')}
        if screen_ready:write(state/'screen-control',f'#!/bin/sh\nexec {python} {screen} {state}/connector.json "$@"\n',0o700)
        current['setupJob']=config['job']
        write(state/'source-revision.json',json.dumps({'packageSha256':config['sha256'],'source':str(source)}))
        conf=Path('/etc/supervisor/conf.d/unified-studio.conf')
        blocks=[]
        for name,command in [('runtime',str(state/'serve')),('connector',str(python)+' -m studio.cloud_connector --config '+str(existing))]:
            blocks.append(f'[program:unified-studio-{name}]\ncommand={command}\ndirectory={source}\nenvironment=PYTHONPATH="{source}"\nautostart=true\nautorestart=true\nstopasgroup=true\nkillasgroup=true\nstartsecs=5\nstdout_logfile={state}/{name}.log\nstderr_logfile={state}/{name}-error.log\nstdout_logfile_maxbytes=2MB\nstderr_logfile_maxbytes=2MB\n')
        content='\n'.join(blocks)
        if conf.exists() and conf.read_text()!=content:
            raise ValueError('A different Studio service configuration already exists. It was preserved.')
        write(conf,content)
        write(existing,json.dumps(current))
        run(['supervisorctl','reread'])
        run(['supervisorctl','update','unified-studio-runtime','unified-studio-connector'])
        status('waiting_for_connector','Hermes and connector installed. Waiting for the authenticated connection.')
    except ValueError as exc:
        status('failed',str(exc))
    except Exception:
        status('failed',phase+' did not complete. Private setup logs are retained on this computer.')


if __name__=='__main__':
    install(sys.argv[1])
