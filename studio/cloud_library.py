"""Explicit snapshots for reviewed computer-to-computer Hermes transfers."""
import base64
import hashlib
import json
from pathlib import Path
import re
import time
import uuid
from .cloud_archive import build_archive
from .cloud_import import atomic_write, digest, allowed

class Library:
    def __init__(self,home):
        self.home=Path(home).resolve();self.base=self.home/'studio-cloud/exports'
    def profiles(self):
        import yaml
        rows=[]
        for p in [self.home]+sorted((self.home/'profiles').glob('*')):
            if p.is_symlink() or not (p/'config.yaml').is_file():continue
            name='default' if p==self.home else p.name
            if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}',name):continue
            meta=yaml.safe_load((p/'profile.yaml').read_text()) if (p/'profile.yaml').is_file() else {}
            rows.append({'id':name,'name':(meta or {}).get('name') or name})
        return {'profiles':rows,'sourcePath':str(self.home),'credentialsExcluded':True}
    def export(self,target,profiles,request,selection=None):
        uuid.UUID(target)
        if not profiles or not isinstance(profiles,list) or len(profiles)>100:raise ValueError('Select between one and 100 Hermes profiles.')
        allowed={p['id'] for p in self.profiles()['profiles']}
        if any(p not in allowed for p in profiles):raise ValueError('A selected Hermes profile is unavailable.')
        if selection:
            from .cloud_skills import selection as validate
            selection=validate(selection.get('sourceProfile'),selection.get('skillIds'),selection.get('targetAgent'))
            if profiles != [selection['sourceProfile']]:raise ValueError('Skill source profile mismatch')
        identity=hashlib.sha256(request.encode()).hexdigest()
        self.base.mkdir(parents=True,exist_ok=True,mode=0o700)
        meta=self.base/(identity+'.json');archive=self.base/(identity+'.zip')
        if meta.exists():
            saved=json.loads(meta.read_text())
            if saved['computerId']!=target or saved['profiles']!=profiles or saved.get('selection')!=selection:raise ValueError('Export request belongs to another selection.')
            return saved
        if archive.exists():archive.unlink() # Only an unpublished interrupted export.
        path,bundle=build_archive(self.home,target,archive,profiles,selection)
        path.replace(archive)
        path=archive
        manifest={**bundle,'profiles':{name:{'files':{key:{k:v for k,v in item.items() if k in {'sha256','size','mode'}} for key,item in profile['files'].items()}} for name,profile in bundle['profiles'].items()}}
        value={'selection':selection,'exportId':identity,'computerId':target,'profiles':profiles,'manifest':manifest,'size':path.stat().st_size,'sha256':digest(path),'created':time.time()}
        atomic_write(meta,json.dumps(value).encode())
        return value
    def chunk(self,identity,offset):
        if not re.fullmatch(r'[a-f0-9]{64}',identity):raise ValueError('Invalid export identity.')
        meta=json.loads((self.base/(identity+'.json')).read_text())
        offset=int(offset)
        if offset<0 or offset>meta['size']:raise ValueError('Invalid export offset.')
        with (self.base/(identity+'.zip')).open('rb') as f:f.seek(offset);data=f.read(1024*1024)
        return {'data':base64.b64encode(data).decode(),'offset':offset,'sha256':digest(data),'size':len(data)}
    def preview(self,computer,manifest):
        if manifest.get('scope')=='skills':
            from .cloud_skills import preview
            return preview(self.home,computer,manifest)
        if manifest.get('computerId')!=computer:raise ValueError('Import preview belongs to another computer.')
        source=manifest.get('sourceId','')
        if not re.fullmatch(r'[a-f0-9]{24}',source):raise ValueError('Invalid import provenance.')
        prior=self.home/'studio/imports'/(source+'.json')
        records=json.loads(prior.read_text()).get('profiles',{}) if prior.exists() else {}
        result=[]
        for name,p in manifest.get('profiles',{}).items():
            if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}',name):raise ValueError('Invalid profile identity.')
            record=records.get(name,{})
            target=record.get('target')
            if target and not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}',target):raise ValueError('Invalid saved import mapping.')
            added=changed=conflicts=unchanged=0
            for key,item in p.get('files',{}).items():
                rel=Path(key)
                if rel.is_absolute() or '..' in rel.parts or '\\' in key or not allowed(rel):raise ValueError('Invalid preview file path.')
                file=self.home/'profiles'/target/rel if target else None
                if file and file.resolve()!=file:raise PermissionError('A linked destination cannot be previewed.')
                current=digest(file) if file and file.is_file() and not file.is_symlink() else None
                if current==item['sha256']:unchanged+=1
                elif current is None:added+=1
                elif current!=record.get('hashes',{}).get(key):conflicts+=1
                else:changed+=1
            result.append({'source':name,'target':target,'newProfile':not bool(target),'added':added,'changed':changed,'conflicts':conflicts,'unchanged':unchanged})
        return {'profiles':result,'warnings':manifest.get('warnings',[]),'credentialsExcluded':True,'conflictPolicy':'Preserve both versions','historyPolicy':'Imported history stays available without filling each prompt.'}
