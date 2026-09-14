#!/usr/bin/env python3
"""Studio source installer. No provisioning, credential copying or model calls."""
from __future__ import annotations
import argparse, getpass, hashlib, json, os, pathlib, platform, re, shutil, subprocess, sys, tempfile, urllib.request, urllib.error, uuid
ROOT=pathlib.Path(__file__).resolve().parents[1]
REMOTE='/opt/hermes-orgo-studio'
APP='Revenue Partner Studio.app'
LEGACY_APPS=['Grok...Ish Bot.app','Hermes Orgo Studio.app']

def run(args, **kw):
    return subprocess.run([str(a) for a in args],check=True,**kw)

def target(value):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.:-]*',value): raise ValueError('Invalid SSH host')
    return 'root@'+value

def validate_id(value):
    parsed=uuid.UUID(value)
    if str(parsed)!=value.lower(): raise ValueError('Use a canonical Orgo computer UUID')
    return str(parsed)

def doctor():
    tools={name:shutil.which(name) for name in ['git','node','npm','uv','ssh','scp']}
    result={'platform':platform.system(),'architecture':platform.machine(),'tools':tools,
            'source':str(ROOT),'mac_supported':sys.platform=='darwin'}
    if tools['node']:
        version=subprocess.check_output(['node','--version'],text=True).strip()
        major,minor=map(int,version.lstrip('v').split('.')[:2]);result['node']=version
        result['node_supported']=major>22 or (major==22 and minor>=22)
    print(json.dumps(result,indent=2))
    return result

def api_check(computer_id,key):
    req=urllib.request.Request('https://www.orgo.ai/api/computers/'+computer_id,headers={'Authorization':'Bearer '+key})
    with urllib.request.urlopen(req,timeout=30) as response: computer=json.load(response)
    if computer.get('id')!=computer_id: raise ValueError('Orgo returned a different computer')
    if computer.get('os') not in [None,'linux']: raise ValueError('Studio requires an Orgo Linux computer')
    return {k:computer.get(k) for k in ['id','name','workspace_id','status','ram','cpu','os']}

def verify_route(computer_id,key,host):
    """Prove SSH reaches the API-selected computer before any installation writes."""
    import shlex
    nonce=uuid.uuid4().hex
    remote_file='/tmp/studio-route-'+uuid.uuid4().hex
    def api_bash(command):
        req=urllib.request.Request('https://www.orgo.ai/api/computers/'+computer_id+'/bash',
            data=json.dumps({'command':command}).encode(),
            headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'},method='POST')
        with urllib.request.urlopen(req,timeout=60) as response:result=json.load(response)
        if not result.get('success'):raise RuntimeError('Orgo route challenge failed')
    try:
        api_bash('umask 077; printf %s '+shlex.quote(nonce)+' > '+remote_file)
        found=ssh(host,'cat '+remote_file,stdout=subprocess.PIPE,text=True).stdout.strip()
        if found!=nonce:raise RuntimeError('SSH destination does not match the selected Orgo computer')
    finally:
        api_bash('rm -f '+remote_file)

def ssh(host,command,**kw):
    # Existing host trust is required. Never disable host verification.
    return run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15',target(host),command],**kw)

def build_mac():
    if sys.platform!='darwin': raise RuntimeError('The Mac app must be built on macOS')
    run(['npm','ci'],cwd=ROOT)
    run(['npm','run','typecheck','--workspace','apps/desktop'],cwd=ROOT)
    run(['npm','run','pack:bot','--workspace','apps/desktop'],cwd=ROOT)
    builds=list((ROOT/'apps/desktop/release').glob('mac*/'+APP))
    arch='mac-arm64' if platform.machine()=='arm64' else 'mac'
    source=ROOT/'apps/desktop/release'/arch/APP
    if not source.is_dir(): raise RuntimeError('Native package missing; refusing a different architecture')
    run(['codesign','--verify','--deep','--strict',source])
    return source

def install_mac(source):
    app=pathlib.Path('/Applications')/APP
    processes=subprocess.check_output(['ps','-axo','args='],text=True)
    legacy=[pathlib.Path('/Applications')/name for name in LEGACY_APPS]
    if any(line.startswith(str(candidate)+'/Contents/MacOS/') for line in processes.splitlines() for candidate in [app,*legacy]):
        raise RuntimeError('Studio is open. Close only Studio, then rerun mac-install; the verified build is retained.')
    staging=pathlib.Path(tempfile.mkdtemp(prefix='studio-install-',dir='/Applications'))
    backup=app.with_name(APP+'.previous')
    try:
        run(['ditto',source,staging/APP]);run(['codesign','--verify','--deep','--strict',staging/APP])
        if backup.exists(): raise RuntimeError('A previous rollback copy exists; review it before another install')
        candidates=[candidate for candidate in [app,*legacy] if candidate.exists()]
        if len(candidates)>1: raise RuntimeError('Multiple Studio app bundles exist. Review their versions before replacing one; existing data is unchanged.')
        previous=candidates[0] if candidates else app
        if previous.exists(): previous.rename(backup)
        try:(staging/APP).rename(app)
        except BaseException:
            if backup.exists() and not app.exists():backup.rename(previous)
            raise
    finally:shutil.rmtree(staging)
    print(json.dumps({'installed':str(app),'previous':str(backup) if backup.exists() else None}))

def install_remote(args):
    computer_id=validate_id(args.computer_id)
    if subprocess.check_output(['git','status','--porcelain','--untracked-files=no'],cwd=ROOT,text=True).strip():
        raise RuntimeError('Commit or preserve local changes first; remote installation uses the exact committed source')
    if not args.confirm_dedicated:raise RuntimeError('Remote bootstrap requires --confirm-dedicated for a fresh dedicated computer')
    # Verify ownership through Orgo before sending a source archive over SSH.
    key=os.environ.get('ORGO_API_KEY') or getpass.getpass('Orgo API key (not saved remotely): ')
    info=api_check(computer_id,key);print(json.dumps(info))
    verify_route(computer_id,key,args.ssh_host)
    preflight="test $(id -u) = 0 && test -d /etc/supervisor && ! test -e /opt/hermes-orgo-studio && ! test -e /root/.hermes/config.yaml && ! test -e /root/.hermes/auth.json && ! test -e /root/.hermes/state.db && ! test -e /root/.hermes/profiles && ! test -e /root/.hermes/studio && ! test -e /root/.hermes/orgo-computer"
    ssh(args.ssh_host,preflight)
    with tempfile.TemporaryDirectory(prefix='studio-source-') as temp:
        archive=pathlib.Path(temp)/'studio-source.tar.gz'
        run(['git','archive','--format=tar.gz','-o',archive,'HEAD'],cwd=ROOT)
        digest=hashlib.sha256(archive.read_bytes()).hexdigest()
        unique='/tmp/studio-source-'+uuid.uuid4().hex+'.tar.gz'
        run(['scp','-q',archive,target(args.ssh_host)+':'+unique])
        import shlex
        command=f"echo '{digest}  {unique}' | sha256sum -c - && mkdir {REMOTE} && tar -xzf {unique} -C {REMOTE} && bash {REMOTE}/distribution/remote-bootstrap.sh {shlex.quote(computer_id)} && rm {unique}"
        ssh(args.ssh_host,command)
    print('Remote runtime installed. Authenticate your selected provider remotely, then configure the Mac.')

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    sub=parser.add_subparsers(dest='command',required=True)
    sub.add_parser('doctor');sub.add_parser('mac-build');sub.add_parser('mac-install')
    remote=sub.add_parser('remote-install');remote.add_argument('--computer-id',required=True);remote.add_argument('--ssh-host',required=True);remote.add_argument('--confirm-dedicated',action='store_true')
    config=sub.add_parser('configure');config.add_argument('--computer-id',required=True);config.add_argument('--ssh-host',required=True)
    check=sub.add_parser('verify');check.add_argument('--computer-id',required=True);check.add_argument('--ssh-host',required=True)
    args=parser.parse_args()
    if args.command=='doctor':doctor()
    elif args.command=='mac-build':build_mac()
    elif args.command=='mac-install':
        arch='mac-arm64' if platform.machine()=='arm64' else 'mac';install_mac(ROOT/'apps/desktop/release'/arch/APP)
    elif args.command=='remote-install':install_remote(args)
    elif args.command=='configure':
        computer_id=validate_id(args.computer_id);target(args.ssh_host)
        key=os.environ.get('ORGO_API_KEY') or getpass.getpass('Orgo API key: ')
        info=api_check(computer_id,key)
        verify_route(computer_id,key,args.ssh_host)
        payload={'computerId':computer_id,'workspaceId':info.get('workspace_id') or '', 'sshHost':args.ssh_host,'apiKey':key}
        run(['node',ROOT/'distribution/configure.mjs'],input=json.dumps(payload),text=True)
    else:
        computer_id=validate_id(args.computer_id)
        ssh(args.ssh_host,f"{REMOTE}/venv/bin/python {REMOTE}/scripts/studio_remote_rpc.py --computer-id {computer_id} studio.snapshot '{{}}'",stdout=subprocess.PIPE)
        print(json.dumps({'remote_rpc':'passed','computerId':computer_id,'host':args.ssh_host}))
if __name__=='__main__':
    try:main()
    except (RuntimeError,ValueError,subprocess.CalledProcessError,urllib.error.URLError) as error:
        print('Studio setup stopped: '+str(error),file=sys.stderr);sys.exit(1)
