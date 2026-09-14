"""Owner-only browsing of explicitly selected folders, never a peer file RPC."""
import base64
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import yaml
from contextlib import contextmanager
from .cloud_import import atomic_write

DENIED={'.ssh','.aws','.azure','.config','.codex','.gnupg','.kube','studio-cloud','auth.json','credentials.json','secrets.json','tokens.json','gateway-token','connector-token','vnc-password','node_modules','.git','.venv','venv'}
def visible(name):
    n=name.lower()
    return n not in DENIED and not n.startswith('.') and not any(word in n for word in ('credential','secret','token','password')) and not n.endswith(('.pem','.key','.p12','.pfx'))

class Explorer:
    def __init__(self,home,computer,agent):
        self.home=Path(home).resolve();self.computer=computer;self.agent=agent
        self.record=self.home/'studio/explorer-roots.json'
    def choose(self):
        if sys.platform != 'darwin': raise ValueError('Use the folder browser for an Orgo computer.')
        # Owner-triggered Finder dialog. No screen-control permission or shell path input.
        result = subprocess.run(['/usr/bin/osascript', '-e',
            'POSIX path of (choose folder with prompt "Choose a work folder for this Hermes profile")'],
            text=True, capture_output=True, timeout=70)
        if result.returncode:
            if '-128' in result.stderr: return {'cancelled': True}
            raise ValueError('The Mac folder picker could not open. Use Browse folders instead.')
        return self.add(result.stdout.strip())

    def folders(self, path=''):
        # This owner-only picker exposes folder names, never file contents or a grant.
        places = [Path.home(), Path('/workspace'), Path('/workspaces'), Path('/mnt'), Path('/Users/Shared')]
        places = [p for p in places if p.is_dir() and not p.is_symlink()]
        if not path:
            return {'path': '', 'parent': '', 'selectable': False,
                    'folders': [{'name': 'Home folders' if p == Path.home() else p.name, 'path': str(p)} for p in places]}
        target = Path(path)
        base = next((p for p in places if target.is_relative_to(p)), None)
        if not base or target.resolve() != target or not target.is_dir() or any(not visible(part) for part in target.relative_to(base).parts):
            raise PermissionError('Choose an available work folder.')
        rows = []
        with self.open_descriptor(target, directory=True) as fd:
            for name in os.listdir(fd):
                if not visible(name): continue
                try: info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                except OSError: continue
                if stat.S_ISDIR(info.st_mode): rows.append({'name': name, 'path': str(target / name)})
        return {'path': str(target), 'parent': '' if target == base else str(target.parent),
                'selectable': target != base and target != self.home and len(target.parts) >= 3,
                'folders': sorted(rows, key=lambda r: r['name'].lower())}
    def roots(self):
        config=yaml.safe_load((self.home/'config.yaml').read_text()) or {}
        cwd=(config.get('terminal') or {}).get('cwd') or str(Path.home()/'studio-projects')
        initial=[Path(os.path.expanduser(cwd)),self.home/'attachments']
        custom=json.loads(self.record.read_text()) if self.record.exists() else []
        result=[]
        for p in initial+[Path(x) for x in custom]:
            if not p.is_absolute() or p.is_symlink() or not p.is_dir():continue
            path=p.resolve()
            # A workspace can be anywhere selected by its owner. Broad system,
            # home, Hermes, or secret roots are never implicit browsing grants.
            if path in {Path('/'),Path.home(),self.home} or any(part.lower() in DENIED for part in path.parts):continue
            row={'id':hashlib.sha256(str(path).encode()).hexdigest()[:24],'name':path.name,'path':str(path)}
            if not any(r['id']==row['id'] for r in result):result.append(row)
        return {'computerId':self.computer,'agentId':self.agent,'roots':result}
    def add(self,path):
        p=Path(os.path.expanduser(path))
        if not p.is_absolute() or p.is_symlink() or not p.is_dir():raise ValueError('Choose an existing absolute folder path, not a link.')
        p=p.resolve()
        if p in {Path('/'),Path.home(),self.home} or any(part.lower() in DENIED or part.startswith('.') for part in p.parts[1:]):
            raise ValueError('Choose a work folder rather than a home, system, or credential folder.')
        if len(p.parts)<3:raise ValueError('Choose a specific work folder.')
        prior=json.loads(self.record.read_text()) if self.record.exists() else []
        atomic_write(self.record,json.dumps(sorted(set(prior+[str(p)]))).encode())
        return self.roots()
    def resolve(self,root,path):
        selected=next((r for r in self.roots()['roots'] if r['id']==root),None)
        if not selected:raise PermissionError('This folder is not approved for this agent.')
        relative=Path(path)
        if relative.is_absolute() or '..' in relative.parts or any(not visible(x) for x in relative.parts):raise PermissionError('This file is not available through Studio.')
        base=Path(selected['path']);target=base
        for part in relative.parts:
            target=target/part
            if target.is_symlink():raise PermissionError('Linked files cannot escape approved folders.')
        if not target.resolve().is_relative_to(base):raise PermissionError('File is outside the approved folder.')
        return target
    def list(self,root,path='',offset=0):
        target=self.resolve(root,path)
        if not target.is_dir():raise ValueError('Choose a folder.')
        offset=max(0,int(offset));rows=[]
        with self.open_descriptor(target,directory=True) as fd:
            for name in os.listdir(fd):
                if not visible(name):continue
                try:s=os.stat(name,dir_fd=fd,follow_symlinks=False)
                except FileNotFoundError:continue
                if not (stat.S_ISREG(s.st_mode) or stat.S_ISDIR(s.st_mode)):continue
                rows.append({'name':name,'path':str(Path(path)/name),'directory':stat.S_ISDIR(s.st_mode),'size':s.st_size,'modified':s.st_mtime})
        rows.sort(key=lambda r:(not r['directory'],r['name'].lower()))
        return {'entries':rows[offset:offset+200],'nextOffset':offset+200 if len(rows)>offset+200 else None}
    @contextmanager
    def open_descriptor(self,target,directory=False):
        # Walk all ancestors by descriptor, so a concurrent rename/symlink swap
        # cannot redirect a checked request into another folder.
        fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
        try:
            parts=target.parts[1:]
            for i,part in enumerate(parts):
                flags=os.O_RDONLY|os.O_NOFOLLOW
                if directory or i<len(parts)-1:flags|=os.O_DIRECTORY
                next_fd=os.open(part,flags,dir_fd=fd);os.close(fd);fd=next_fd
            yield fd
        finally:os.close(fd)
    def read(self,root,path,offset=0,expected=None):
        target=self.resolve(root,path)
        offset=int(offset)
        if offset<0:raise ValueError('Invalid read offset.')
        with self.open_descriptor(target) as fd:
            info=os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_size>25*1024**2:raise ValueError('Only regular files up to 25 MB can be downloaded here.')
            version=hashlib.sha256(f'{info.st_ino}:{info.st_size}:{info.st_mtime_ns}'.encode()).hexdigest()
            if expected and expected!=version:raise ValueError('The file changed during download. Start again for a consistent copy.')
            os.lseek(fd,offset,os.SEEK_SET);data=os.read(fd,512*1024)
        return {'name':target.name,'size':info.st_size,'version':version,'offset':offset,'nextOffset':offset+len(data),'data':base64.b64encode(data).decode(),'complete':offset+len(data)>=info.st_size}
