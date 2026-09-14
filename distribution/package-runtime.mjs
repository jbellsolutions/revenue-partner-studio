import {readdirSync,lstatSync,mkdirSync,copyFileSync,readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {tmpdir} from 'node:os'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
const root=resolve(process.argv[2]||'.'),output=resolve(process.argv[3]||'cloud/dist/setup')
const trees=['brand','acp_adapter','agent','assets','cron','gateway','hermes','hermes_cli','locales','plugins','providers','studio','tools','tui_gateway','skills','native','distribution']
const files=['pyproject.toml','uv.lock','setup.py','README.md','LICENSE','NOTICE.md','PROVENANCE.md','cli-config.yaml.example']
const excluded=new Set(['node_modules','__pycache__','.venv','venv','.git','.DS_Store','.env'])
const temp=mkdtempSync(join(tmpdir(),'studio-runtime-'))
function copy(source,target) {
  const info=lstatSync(source)
  if(info.isSymbolicLink())return
  if(info.isDirectory()) {
    mkdirSync(target,{recursive:true})
    for(const name of readdirSync(source)) if(!excluded.has(name)&&!name.startsWith('._')&&!name.endsWith('.pyc'))copy(join(source,name),join(target,name))
  }else copyFileSync(source,target)
}
try {
  for(const name of [...trees,...files,...readdirSync(root).filter(n=>n.endsWith('.py'))])copy(join(root,name),join(temp,name))
  mkdirSync(output,{recursive:true})
  execFileSync('tar',['-czf',join(output,'runtime.tar.gz'),'-C',temp,'.'],{env:{...process.env,COPYFILE_DISABLE:'1'}})
  writeFileSync(join(output,'runtime.sha256'),createHash('sha256').update(readFileSync(join(output,'runtime.tar.gz'))).digest('hex'))
  copyFileSync(join(root,'distribution/connect.py'),join(output,'connect.py'))
  copyFileSync(join(root,'distribution/connect-local.py'),join(output,'connect-local.py'))
  console.log('Created the Studio runtime package and checksum.')
} finally {rmSync(temp,{recursive:true,force:true})}
