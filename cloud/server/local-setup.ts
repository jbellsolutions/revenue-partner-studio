import {randomUUID} from 'node:crypto'
import {readFileSync} from 'node:fs'
import path from 'node:path'
import {ControlStore} from './control-store.ts'

// A stored ZIP preserves the executable bit of the Mac connection launcher.
// It contains only the reviewed installer source and an expiring pairing code.
export function setupZip(files:{name:string;data:Buffer;mode:number}[]) {
  const pieces:Buffer[]=[],central:Buffer[]=[];let offset=0
  for(const file of files){
    const name=Buffer.from(file.name);let crc=0xffffffff
    for(const byte of file.data){crc^=byte;for(let n=0;n<8;n++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}crc=(crc^0xffffffff)>>>0
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(crc,14);local.writeUInt32LE(file.data.length,18);local.writeUInt32LE(file.data.length,22);local.writeUInt16LE(name.length,26)
    pieces.push(local,name,file.data)
    const entry=Buffer.alloc(46);entry.writeUInt32LE(0x02014b50);entry.writeUInt16LE(0x0314,4);entry.writeUInt16LE(20,6);entry.writeUInt32LE(crc,16);entry.writeUInt32LE(file.data.length,20);entry.writeUInt32LE(file.data.length,24);entry.writeUInt16LE(name.length,28);entry.writeUInt32LE((file.mode<<16)>>>0,38);entry.writeUInt32LE(offset,42)
    central.push(entry,name);offset+=30+name.length+file.data.length
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16)
  return Buffer.concat([...pieces,directory,end])
}
export function localSetup(control:ControlStore,origin:string,assets:string,p:any) {
  let id=p.computerId
  if(id){const c=(control.computers() as any[]).find(c=>c.id===id&&c.kind==='local');if(!c)throw Error('Choose the saved Mac connection.')}
  else {id=randomUUID();control.store.addComputer(id,String(p.name||'My Mac').slice(0,100));control.store.db.prepare("UPDATE computers SET kind='local',platform='darwin' WHERE id=?").run(id)}
  const pair=control.pairing(id),job=randomUUID()
  const config={kind:'local',computerId:id,origin,pair:pair.code,job,created:Date.now(),artifactUrl:origin+'/setup/artifacts/'+pair.code+'/runtime.tar.gz',sha256:readFileSync(path.join(assets,'runtime.sha256'),'utf8').trim()}
  control.saveJob(job,id,'download_ready','Open the connection download on your Mac. It contains its private setup details.',config)
  return {computerId:id,job,expires:pair.expires,download:'/api/connections/local/'+job+'/download'}
}
export function localDownload(control:ControlStore,assets:string,id:string) {
  const job=control.job(id)
  if(!job||job.private.kind!=='local'||job.private.created<Date.now()-600000)throw Error('This download expired. Prepare a new connection download.')
  const script=readFileSync(path.join(assets,'connect-local.py'))
  const launcher=Buffer.from('#!/bin/zsh\nset -eu\ncd -- "${0:A:h}"\n/usr/bin/python3 ./connect-local.py ./connection.json\n')
  return setupZip([{name:'Connect Revenue Partner Studio/Connect Revenue Partner Studio.command',data:launcher,mode:0o100700},{name:'Connect Revenue Partner Studio/connect-local.py',data:script,mode:0o100600},{name:'Connect Revenue Partner Studio/connection.json',data:Buffer.from(JSON.stringify(job.private)),mode:0o100600}])
}
