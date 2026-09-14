#!/usr/bin/env python3
"""Install only Studio's private companion; reuse the installed native Hermes."""
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import secrets
import shutil
import socket
import sqlite3
import subprocess
import sys
import tarfile
import time
import urllib.request
from contextlib import closing

def write(path,data):
    path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    temporary=path.with_name(path.name+'.new')
    with temporary.open('wb') as f:os.chmod(temporary,0o600);f.write(data);f.flush();os.fsync(f.fileno())
    temporary.replace(path)

def start_service(domain,plist,diagnostics):
    # bootout can return while launchd is still removing the previous job.
    # Seeing that old job in `print` is not evidence that bootstrap succeeded.
    for attempt in range(60):
        result=subprocess.run(['/bin/launchctl','bootstrap',domain,str(plist)],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        if result.returncode==0:return
        time.sleep(0.5)
    write(diagnostics,result.stderr)
    raise RuntimeError('The companion service could not start. Private diagnostics were saved; reopening this installer resumes setup.')

def native_install(home):
    candidates=[home/'hermes-agent',Path.home()/'hermes-agent',Path.home()/'.local/share/hermes/hermes-agent']
    for source in candidates:
        for name in ('venv','.venv'):
            python=source/name/'bin/python'
            if python.is_file() and (source/'tui_gateway/server.py').is_file():return source,python
    raise RuntimeError('A compatible local Hermes installation was not found. Install Hermes first, then reopen this connection download.')

def extract(archive,target):
    target.mkdir(mode=0o700,parents=True,exist_ok=True)
    with tarfile.open(archive) as pack:
        for item in pack.getmembers():
            path=Path(item.name)
            if path.is_absolute() or '..' in path.parts or item.issym() or item.islnk() or not (item.isdir() or item.isfile()):raise RuntimeError('Unsafe runtime package.')
        pack.extractall(target,filter='data')

def snapshot(home,backup):
    profiles=[home]+[p for p in (home/'profiles').glob('*') if p.is_dir() and not p.is_symlink()]
    databases=[p for root in profiles for p in root.glob('*.db') if p.is_file() and not p.is_symlink()]
    if sum(p.stat().st_size for p in databases)+1024**3>shutil.disk_usage(home).free:raise RuntimeError('Not enough free space for verified Hermes backups and a 1 GB reserve.')
    for root in profiles:
        dest=backup/('default' if root==home else root.name);dest.mkdir(parents=True,exist_ok=True,mode=0o700)
        for name in ('config.yaml','auth.json','.env','SOUL.md','AGENTS.md','USER.md','MEMORY.md','profile.yaml'):
            p=root/name
            if p.is_file() and not p.is_symlink():write(dest/name,p.read_bytes())
        for p in root.glob('*.db'):
            if p.is_symlink():continue
            out=dest/p.name
            if out.exists():continue
            temporary=out.with_suffix('.snapshot')
            with closing(sqlite3.connect(p.as_uri()+'?mode=ro',uri=True)) as source,closing(sqlite3.connect(temporary)) as target:
                temporary.chmod(0o600);source.execute('BEGIN');source.execute('SELECT count(*) FROM sqlite_master').fetchone();source.backup(target,pages=1024)
                if target.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise RuntimeError('A Hermes backup failed integrity verification.')
            temporary.replace(out)

def build_companion(source,target):
    target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    # Some Macs have a newer default SDK than their compiler. Try compatible
    # installed SDKs without changing the user's global developer selection.
    sdks=[None]+sorted(Path('/Library/Developer/CommandLineTools/SDKs').glob('MacOSX*.sdk'),reverse=True)
    errors=[]
    for sdk in sdks:
        cache=Path.home()/'Library/Caches/Grokish Studio Companion/compiler-cache'
        cache.mkdir(parents=True,exist_ok=True)
        command=['/usr/bin/swiftc',str(source),'-o',str(target),'-module-cache-path',str(cache)]
        if sdk:command+=['-sdk',str(sdk)]
        result=subprocess.run(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        if result.returncode==0:return
        errors.append(result.stderr.decode(errors='replace'))
    write(target.parent/'compiler-error.log','\n'.join(errors).encode())
    raise RuntimeError('The Mac companion could not compile. Compatible Apple command line developer tools are required; details were saved privately.')

def install(configuration):
    if sys.platform!='darwin':raise RuntimeError('This connection download is for a Mac.')
    os.umask(0o077)
    home=Path(os.environ.get('HERMES_HOME',str(Path.home()/'.hermes'))).resolve()
    source,python=native_install(home)
    # Hermes supplies a modern Python with its installed dependencies.
    if Path(sys.executable).resolve()!=python.resolve():os.execv(str(python),[str(python),str(Path(__file__).resolve()),str(configuration)])
    support=Path.home()/'Library/Application Support/Grokish Studio Companion';support.mkdir(parents=True,exist_ok=True,mode=0o700)
    lock=(support/'install.lock').open('a+');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    incoming=json.loads(configuration.read_text());origin=incoming['origin'].rstrip('/')
    from urllib.parse import urlparse
    if urlparse(origin).scheme!='https':raise RuntimeError('Studio requires a secure HTTPS address.')
    base=home/'studio-cloud';base.mkdir(exist_ok=True,mode=0o700)
    binding=base/'local-computer.json'
    if binding.exists() and json.loads(binding.read_text()).get('computerId')!=incoming['computerId']:raise RuntimeError('This Mac is already paired with another computer identity. Use its saved connection in Studio to reconnect.')
    progress=support/('setup-'+incoming['job']+'.json')
    state=json.loads(progress.read_text()) if progress.exists() else incoming
    def save():write(progress,json.dumps(state).encode())
    if not state.get('token'):
        print('Pairing this Mac with your private Studio…',flush=True)
        body=json.dumps({'computerId':state['computerId'],'code':state['pair'],'platform':'darwin'}).encode()
        request=urllib.request.Request(origin+'/api/pairing/exchange',data=body,headers={'Content-Type':'application/json','Origin':origin})
        try:
            with urllib.request.urlopen(request,timeout=30) as response:state['token']=json.load(response)['token']
        except Exception:raise RuntimeError('The connection download expired or Studio could not be reached. Prepare a new download for this saved Mac in Studio.')
        save()
    runtime=support/('runtime-'+state['sha256'][:16])
    if not (runtime/'.complete').exists():
        print('Downloading the verified Studio extension…',flush=True)
        archive=support/'runtime.tar.gz'
        with urllib.request.urlopen(state['artifactUrl'],timeout=120) as response,archive.open('wb') as out:shutil.copyfileobj(response,out)
        with archive.open('rb') as data:actual=hashlib.file_digest(data,'sha256').hexdigest()
        if actual!=state['sha256']:raise RuntimeError('The Studio extension checksum did not match.')
        extract(archive,runtime);write(runtime/'.complete',b'verified');archive.unlink()
    app=support/'Revenue Partner Studio Companion.app';executable=app/'Contents/MacOS/StudioCompanion'
    if not executable.exists():
        print('Preparing the companion menu and desktop permission controls…',flush=True)
        build_companion(runtime/'distribution/companion.swift',executable)
    # Repair an interrupted first build as well. Compiler caches are not app
    # resources and must never be included in the signed application bundle.
    cache=executable.parent/'compiler-cache'
    if cache.is_dir():shutil.rmtree(cache)
    write(app/'Contents/Info.plist',plistlib.dumps({'CFBundleIdentifier':'com.jbellsolutions.grokish.companion','CFBundleName':'Revenue Partner Studio Companion','CFBundleDisplayName':'Revenue Partner Studio Companion','CFBundleExecutable':'StudioCompanion','CFBundlePackageType':'APPL','CFBundleShortVersionString':'0.3.0','CFBundleVersion':'3','LSUIElement':True,'NSPrincipalClass':'NSApplication','NSScreenCaptureUsageDescription':'View this Mac during a desktop session approved in Studio.'}))
    signed=subprocess.run(['/usr/bin/codesign','--force','--sign','-',str(app)],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
    if signed.returncode:
        write(support/'signing-error.log',signed.stderr)
        raise RuntimeError('The companion could not be signed. Private signing details were saved; existing Hermes is unchanged.')
    subprocess.run(['/usr/bin/codesign','--verify','--strict',str(app)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
    if not state.get('backup'):
        print('Creating and verifying private backups of your existing Hermes profiles…',flush=True)
        state.setdefault('backupPath',str(support/('backups/'+time.strftime('%Y%m%d-%H%M%S'))));save()
        backup=Path(state['backupPath']);snapshot(home,backup);state['backup']=str(backup);save()
    connector_file=base/'local-connector.json'
    previous=json.loads(connector_file.read_text()) if connector_file.exists() else {}
    port=previous.get('port')
    if not port:
        for candidate in range(8791,8801):
            with socket.socket() as probe:
                try:probe.bind(('127.0.0.1',candidate));port=candidate;break
                except OSError:continue
        if not port:raise RuntimeError('No free local Studio port was available.')
    token_file=base/'local-connector-token';runtime_token=base/'local-runtime-token'
    write(token_file,state['token'].encode())
    if not runtime_token.exists():write(runtime_token,secrets.token_urlsafe(32).encode())
    write(binding,json.dumps({'computerId':state['computerId'],'cloudUrl':origin}).encode())
    cfg={'setupJob':state['job'],'kind':'local','computerId':state['computerId'],'hermesHome':str(home),'nativeSource':str(source),'sourceDir':str(runtime),'port':port,'stateDir':str(base/'local-connector'),'hermesUrl':'http://127.0.0.1:'+str(port),'hermesOrigin':'http://127.0.0.1:'+str(port),'hermesTokenFile':str(runtime_token),'cloudUrl':origin,'connectorTokenFile':str(token_file),'desktopHelper':str(executable)}
    write(connector_file,json.dumps(cfg).encode());write(support/'config.json',json.dumps(cfg).encode())
    launch=runtime/'distribution/local-launch.py'
    environment={**os.environ,'PYTHONPATH':str(runtime),'HERMES_HOME':str(home),'STUDIO_COMPUTER_ID':state['computerId'],'STUDIO_COMPUTER_KIND':'local'}
    probe=subprocess.run([str(python),'-m','studio.local_runtime','--native',str(source),'--check'],env=environment,cwd=str(runtime),stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    if probe.returncode:raise RuntimeError('Your Hermes version is not compatible with this Studio extension. Existing Hermes remains available.')
    domain='gui/'+str(os.getuid());agents=Path.home()/'Library/LaunchAgents';agents.mkdir(exist_ok=True)
    for suffix,arguments in [('runtime',[str(python),str(launch),str(connector_file),'runtime']),('connector',[str(python),str(launch),str(connector_file),'connector']),('menu',[str(executable)])]:
        label='com.jbellsolutions.grokish-studio.'+suffix;plist=agents/(label+'.plist')
        value={'Label':label,'ProgramArguments':arguments,'RunAtLoad':True,'KeepAlive':suffix!='menu','WorkingDirectory':str(runtime),'StandardOutPath':str(support/(suffix+'.log')),'StandardErrorPath':str(support/(suffix+'.log')),'ThrottleInterval':5,'ProcessType':'Interactive'}
        subprocess.run(['/bin/launchctl','bootout',domain+'/'+label],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        write(plist,plistlib.dumps(value))
        start_service(domain,plist,support/'service-error.log')
    state['installed']=True;save()
    print('Studio companion installed. Your Mac will appear in Studio shortly. The ✳ menu can stop access. Desktop viewing requires its separate permissions.',flush=True)
    return cfg

if __name__=='__main__':
    try:install(Path(sys.argv[1]).resolve())
    except Exception as error:
        print('Studio setup: '+(str(error) if isinstance(error,RuntimeError) else 'Setup could not finish. Your existing Hermes installation was preserved.'),file=sys.stderr);sys.exit(1)
