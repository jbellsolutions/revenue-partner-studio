import {readFileSync} from 'node:fs'
import {describe,it,expect} from 'vitest'
const source=readFileSync('src/plugins/hermes-bots/legacy-plugin.js','utf8')
const body=source.slice(source.indexOf('function rosterRequestParams()'),source.indexOf('function useRoster()'))
const params=(search:string)=>new Function('window',body+';return rosterRequestParams()')({location:{search}})
describe('existing remote Hermes workspace',()=>{
 it('loads names without blocking on every history while preserving Studio activity polling',()=>{
  expect(params('?workspace=hermes')).toEqual({include_sessions:false})
  expect(params('')).toEqual({})
 })
 it('dispatches existing-host groups through native Hermes instead of unavailable Studio tools',()=>{
  const start=source.indexOf('function existingHermesGroupEnvelope(')
  const end=source.indexOf('// ── bot row',start)
  const make=new Function('window','mentionedGroupParticipants','participantLabel','botGroupReplyStart','BOT_GROUP_REPLY_END','BOT_GROUP_CONTEXT_START','BOT_GROUP_CONTEXT_END',source.slice(start,end)+';return groupRoutingEnvelope')
  const call=make({location:{search:'?workspace=hermes'}},()=>[],(p:string)=>p,(p:string)=>p,'END','START','STOP')
  const result=call({title:'Test',profile:'default',participantIds:['default','researcher']},'Research',[])
  expect(result).toContain('hermes -p researcher chat')
  expect(result).toContain('Never invent a participant reply')
  expect(result).not.toContain('studio_team')
 })
})
it('restores the saved bot but does not override a newer user selection',async()=>{
 const start=source.indexOf('async function restoreWorkspaceConversation(')
 const end=source.indexOf('function isCurrentNavigationIntent(',start)
 const create=new Function('pluginCtx','openBotChat','openBotGroup','$botGroups',`let navigationIntentEpoch=0;let navigationIntentTarget='';const pluginDisposed=false;${source.slice(start,end)};return {restore:restoreWorkspaceConversation,click:()=>{navigationIntentEpoch++;navigationIntentTarget='bot:other'}}`)
 const opened:string[]=[]
 let resolve!:(s:string)=>void
 const storage={get:()=>new Promise<string>(r=>{resolve=r})}
 const ui=create({storage},(b:{name:string})=>opened.push(b.name),()=>{}, {get:()=>({})})
 const bots=[{name:'default'},{name:'team-gtm'}]
 const first=ui.restore(bots);resolve('bot:team-gtm');await first
 expect(opened).toEqual(['team-gtm'])
 const second=ui.restore(bots);ui.click();resolve('bot:default');await second
 expect(opened).toEqual(['team-gtm'])
})
