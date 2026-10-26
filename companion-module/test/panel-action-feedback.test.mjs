import assert from 'node:assert/strict'
import {test} from 'node:test'
import OnAir from '../src/index.js'
import {PanelProgress} from '../src/panel-progress.js'
const status=(sequence,extra={})=>({receiverInstanceId:'test-boot',statusSequence:sequence,state:'available',busy:false,confirmed:'available',tableVersion:1,...extra})
async function setup(t){
 const inst=Object.create(OnAir.prototype),seen={variables:{},repaints:[]}
 for(const method of ['setActionDefinitions','setFeedbackDefinitions','setVariableDefinitions','setPresetDefinitions','updateStatus','log'])inst[method]=()=>{}
 inst.setVariableValues=v=>Object.assign(seen.variables,v)
 inst.checkFeedbacks=(...ids)=>seen.repaints.push(ids)
 await inst.init({});inst.cancelRequests();inst.config={host:'fixture.invalid',port:8484,passphrase:'test'}
 inst.states=[{id:'available',label:'AVAILABLE',busy:false,color:'#ffffff',bgcolor:'#0b6e2e'},{id:'unknown',label:'NO DATA',busy:true,color:'#ff00ff',bgcolor:'#111111'}];inst.tableVersion=1
 inst.ingest(status(1));inst.poll=async()=>false
 let clock=0;inst.panelProgress=new PanelProgress({now:()=>clock})
 const originalFetch=globalThis.fetch;t.after(async()=>{globalThis.fetch=originalFetch;await inst.destroy()})
 const value=field=>inst.buildFeedbacks().command_progress_value.callback({options:{kind:'panel',field}})
 return {inst,seen,value,setTime:t=>{clock=t}}
}

test('real toggle action paints acknowledgement before HTTP, coalesces repeats, and waits for a physical transition',async t=>{
 const {inst,seen,value}=await setup(t);let deliver,calls=0
 globalThis.fetch=()=>{calls++;return new Promise(resolve=>deliver=resolve)}
 const action=inst.buildActions().panel_toggle.callback
 const pending=action({options:{}})
 assert.equal(value('visible'),true);assert.equal(value('caption'),'SENDING')
 assert(seen.repaints.some(ids=>ids.includes('command_progress_value')))
 await action({options:{}});assert.equal(calls,1);assert.equal(value('caption'),'WAIT')
 deliver(Response.json({ok:true,delivered:true,asked:'sleep',wasDark:false}));await pending
 assert.equal(seen.variables.last_command_status,'accepted');assert.equal(seen.variables.panel_command_phase,'delivered');assert.equal(value('visible'),true)
 inst.ingest(status(1));inst.ingest(status(2,{message:'unrelated'}));assert.equal(seen.variables.panel_command_phase,'delivered')
 inst.ingest(status(3,{confirmed:'unknown',confirmedReason:'asleep'}));assert.equal(seen.variables.panel_command_phase,'confirmed');assert.equal(value('visible'),false)
 await new Promise(resolve=>setTimeout(resolve,800));assert.equal(inst.commandTimer,null)
})

test('estimated drain and deadline change presentation without additional network requests or fabricated success',async t=>{
 const {inst,seen,value,setTime}=await setup(t);let calls=0
 globalThis.fetch=async()=>{calls++;return Response.json({delivered:true,asked:'sleep',wasDark:false})}
 await inst.panelSleep('toggle');assert.equal(value('caption'),'CHECK ~10s')
 setTime(4250);inst.refreshCommandPresentation();assert.equal(value('caption'),'CHECK ~6s');assert.equal(value('fraction'),.575)
 setTime(11000);inst.refreshCommandPresentation();assert.equal(value('caption'),'CHECK +1s');assert.equal(value('pulsing'),true)
 setTime(20000);inst.refreshCommandPresentation();assert.equal(seen.variables.panel_command_phase,'uncertain');assert.equal(value('caption'),'NO CONF');assert.equal(value('visible'),true);assert.equal(inst.commandTimer,null);assert.equal(calls,1)
 inst.ingest(status(2,{confirmed:'unknown',confirmedReason:'asleep'}));assert.equal(value('visible'),false,'late new physical confirmation clears expired notice')
})

test('state-cycle presses remain uncoalesced and cannot erase an independent panel confirmation wait',async t=>{
 const {inst,seen}=await setup(t);const calls=[]
 globalThis.fetch=async url=>{calls.push(url);return Response.json(url.includes('/panel/')?{delivered:true,asked:'sleep',wasDark:false}:status(1))}
 await inst.panelSleep('toggle')
 await Promise.all([inst.cycleState(['available']),inst.cycleState(['available']),inst.cycleState(['available'])])
 assert.equal(calls.filter(x=>x.includes('/cycle')).length,3)
 assert.equal(seen.variables.panel_command_phase,'delivered')
 assert.match(seen.variables.last_command,/cycle state/)
 assert.equal(inst.commandButtonValue('state','visible'),true)
 inst.ingest(status(2,{confirmed:'unknown',confirmedReason:'asleep'}));await new Promise(resolve=>setTimeout(resolve,800))
 assert.equal(inst.commandButtonValue('state','visible'),false);assert.equal(inst.commandTimer,null)
})

test('Receiver restart and lost contact invalidate progress; teardown prevents late callbacks reviving it',async t=>{
 const {inst,seen,value}=await setup(t)
 globalThis.fetch=async()=>Response.json({delivered:true,asked:'sleep',wasDark:false})
 await inst.panelSleep('toggle');inst.ingest({...status(1),receiverInstanceId:'next-boot'})
 assert.equal(seen.variables.panel_command_result,'receiver-changed');assert.equal(value('caption'),'RESTART')
 await inst.panelSleep('toggle');inst.lastContactAt=0;inst.refreshCommandPresentation()
 assert.equal(seen.variables.panel_command_result,'contact-lost');assert.equal(inst.commandTimer,null)
 inst.ingest({...status(2),receiverInstanceId:'next-boot'});let deliver
 globalThis.fetch=()=>new Promise(resolve=>deliver=resolve)
 const pending=inst.panelSleep('toggle');await inst.destroy();const before={...seen.variables}
 deliver(Response.json({delivered:true,asked:'sleep',wasDark:false}));await pending
 assert.deepEqual(seen.variables,before);assert.equal(inst.commandTimer,null);assert.equal(inst.panelProgress.view().phase,'idle')
})

test('unknown physical evidence keeps only a marked last-seen icon and never inherits it across Receiver epochs',async t=>{
 const {inst,value}=await setup(t)
 inst.ingest(status(2,{confirmed:'unknown',confirmedReason:'asleep'}))
 globalThis.fetch=async()=>Response.json({delivered:true,asked:'wake',wasDark:true})
 await inst.panelSleep('toggle')
 inst.ingest(status(3,{confirmed:'unknown',confirmedReason:'unreachable'}))
 assert.equal(value('known'),true);assert.equal(value('header'),'LAST SEEN');assert.equal(value('caption'),'NO CONF');assert.equal(value('fraction'),0)
 assert.equal(inst.buildFeedbacks().panel_last_seen_asleep.callback(),true)
 assert.equal(inst.panelObservation().physical,'unknown','display cache must never become confirmation evidence')
 inst.ingest({...status(1,{confirmed:'unknown',confirmedReason:'unreachable'}),receiverInstanceId:'another-receiver'})
 assert.equal(value('known'),false);assert.equal(value('header'),'UNKNOWN')
 assert.equal(inst.buildFeedbacks().panel_last_seen_asleep.callback(),false)
})

test('the existing liveness tick fences late confirmation after an expired wait loses contact',async t=>{
 const {inst,seen,setTime}=await setup(t)
 globalThis.fetch=async()=>Response.json({delivered:true,asked:'sleep',wasDark:false})
 await inst.panelSleep('toggle');setTime(20000);inst.refreshCommandPresentation()
 assert.equal(seen.variables.panel_command_result,'not-confirmed');assert.equal(inst.commandTimer,null)
 inst.lastContactAt=0;inst.tick();assert.equal(seen.variables.panel_command_result,'contact-lost')
 inst.ingest(status(2,{confirmed:'unknown',confirmedReason:'asleep'}));assert.notEqual(seen.variables.panel_command_phase,'confirmed')
})
