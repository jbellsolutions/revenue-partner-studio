"""One explicit, expiring owner session for the Mac's physical desktop."""
import asyncio
import base64
import json
from pathlib import Path
import time
from .cloud_import import atomic_write

def access(home):
    base=Path(home)/'studio-cloud'
    if (base/'access-paused').exists():return {}
    try:value=json.loads((base/'desktop-access.json').read_text())
    except (OSError,ValueError):return {}
    return value if value.get('expires',0)>time.time() and not value.get('stopped') else {}

def may_automate(home,agent):
    value=access(home)
    return value.get('agentId')==agent and not value.get('paused',True)

class LocalScreen:
    def __init__(self,connector):
        self.connector=connector;self.path=connector.home/'studio-cloud/desktop-access.json'
        self.lock=asyncio.Lock()
    def operation(self,agent,method):
        c=self.connector;c.profile(agent);value=access(c.home)
        if method=='screen.authorize':
            if (c.home/'studio-cloud/access-paused').exists():raise PermissionError('Studio access was stopped on this Mac. Resume it from the companion menu.')
            if value and value.get('agentId')!=agent:raise PermissionError('Another agent owns this Mac desktop session. Stop that session before assigning it here.')
            value={'computerId':c.computer,'agentId':agent,'expires':time.time()+1800,'paused':False,'stopped':False}
        elif not value or value.get('agentId')!=agent:
            raise PermissionError('Approve a 30-minute desktop session for this agent first.')
        elif method=='screen.pause':value['paused']=True
        elif method=='screen.resume':value['paused']=False
        elif method=='screen.stop':value['stopped']=True
        elif method!='screen.open':raise ValueError('Unsupported Mac desktop operation.')
        atomic_write(self.path,json.dumps(value).encode())
        return {**value,'transport':'mac-frames','sharedScreen':True}
    def require(self,agent):
        value=access(self.connector.home)
        if value.get('agentId')!=agent:raise PermissionError('This Mac desktop session has ended.')
        return value
    async def helper(self,*args):
        process=await asyncio.create_subprocess_exec(self.connector.config['desktopHelper'],*args,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.DEVNULL)
        try:stdout,_=await asyncio.wait_for(process.communicate(),15)
        except BaseException:
            if process.returncode is None:process.kill()
            await process.wait();raise
        try:value=json.loads(stdout)
        except ValueError:raise RuntimeError('The Mac companion could not complete this desktop action.')
        if process.returncode or value.get('error'):raise RuntimeError(value.get('error','Mac desktop unavailable.'))
        return value
    async def frame(self,agent):
        async with self.lock:
            self.require(agent);path=self.connector.base/'current-desktop.jpg'
            try:
                info=await self.helper('--capture',str(path));self.require(agent)
                return {'type':'frame','data':'data:image/jpeg;base64,'+base64.b64encode(path.read_bytes()).decode(),**info}
            finally:path.unlink(missing_ok=True)
    async def input(self,agent,value):
        async with self.lock:
            if not self.require(agent).get('paused'):raise PermissionError('Take control before sending desktop input.')
            encoded=json.dumps(value).encode()
            if len(encoded)>20000:raise ValueError('Desktop input is too large.')
            await self.helper('--input',base64.b64encode(encoded).decode())
