import assert from 'node:assert/strict'
import { test } from 'node:test'
import OnAir from '../src/index.js'

async function instance(t) {
 const inst=Object.create(OnAir.prototype)
 for(const method of ['setActionDefinitions','setFeedbackDefinitions','setVariableDefinitions','setPresetDefinitions','updateStatus','log','checkFeedbacks'])inst[method]=()=>{}
 const variables={};inst.setVariableValues=v=>Object.assign(variables,v)
 await inst.init({})
 inst.states=[{id:'available',label:'AVAILABLE',busy:false,color:'#ffffff',bgcolor:'#0b6e2e',order:0},{id:'on-air',label:'ON AIR',busy:true,color:'#ffffff',bgcolor:'#c1121f',order:1},{id:'unknown',label:'NO DATA',busy:true,color:'#ffffff',bgcolor:'#000000',order:99}]
 inst.tableVersion=1
 t.after(()=>inst.destroy())
 return {inst,variables}
}
const status=(receiverInstanceId,statusSequence,extra={})=>({receiverInstanceId,statusSequence,state:'available',busy:false,confirmed:'available',tableVersion:1,ageSeconds:0,...extra})

test('Receiver sequence outranks arrival order and duplicate heartbeats update contact/age only',async(t)=>{
 const {inst,variables}=await instance(t)
 inst.ingest(status('boot-a',4,{state:'on-air',busy:true,confirmed:'on-air'}))
 inst.lastContactAt=Date.now()-10000
 inst.ingest(status('boot-a',3))
 assert.equal(inst.current.state,'on-air')
 assert.equal(variables.receiver_instance_id,'boot-a')
 assert.equal(variables.status_sequence,4)
 assert(Date.now()-inst.lastContactAt<100)
 inst.ingest(status('boot-a',4,{ageSeconds:25}))
 assert.equal(inst.current.state,'on-air','duplicate cannot rewrite semantics')
 assert.equal(variables.age_seconds,25)
 inst.ingest(status('boot-a',5,{confirmed:'unknown',confirmedReason:'asleep'}))
 assert.equal(inst.current.confirmedReason,'asleep')
})

test('a new Receiver boot retires old ids and rejects late old-stream payloads',async(t)=>{
 const {inst,variables}=await instance(t)
 inst.ingest(status('boot-a',100))
 inst.ingest(status('boot-b',1,{state:'on-air',busy:true,confirmed:'on-air'}))
 assert.equal(inst.ingest(status('boot-a',101)),false)
 assert.equal(inst.receiverInstanceId,'boot-b')
 assert.equal(variables.receiver_instance_id,'boot-b')
 assert.equal(variables.status_sequence,1)
 assert.equal(inst.current.state,'on-air')
})

test('ordered HTTP updates can beat intervening older observations in the same boot',async(t)=>{
 const {inst}=await instance(t)
 inst.ingest(status('boot-a',1))
 const request=inst.beginRequest(1000)
 inst.ingest(status('boot-a',2))
 assert.equal(inst.ingestResponse(status('boot-a',3,{state:'on-air',busy:true,confirmed:'on-air'}),request),true)
 assert.equal(inst.current.state,'on-air')
 assert.equal(inst.ingestResponse(status('boot-old',99),request),false,'unknown epoch still needs request fence')
})

test('partial ordering tuples are invalid and legacy rollback requires a fresh stream boundary',async(t)=>{
 const {inst,variables}=await instance(t)
 assert.equal(inst.ingest({...status('boot-a',1),statusSequence:undefined}),false)
 assert.equal(inst.ingest({...status('boot-a',1),receiverInstanceId:undefined}),false)
 inst.ingest(status('boot-a',3,{state:'on-air',busy:true}))
 const legacy={state:'available',busy:false,confirmed:'available',tableVersion:1}
 assert.equal(inst.ingest(legacy),false)
 inst.handleEvent('data: '+JSON.stringify(legacy),true)
 assert.equal(inst.current.state,'available')
 assert.equal(inst.receiverInstanceId,null)
 assert.equal(variables.receiver_instance_id,'')
 assert.equal(variables.status_sequence,'')
 assert.equal(inst.ingest(status('boot-a',4)),false)
 assert.equal(inst.ingest(status('boot-b',1)),true)
})

test('newer command diagnostics cannot be overwritten by an older completion or teardown',async(t)=>{
 const {inst,variables}=await instance(t)
 const first=inst.beginCommand('first'),second=inst.beginCommand('second')
 inst.finishCommand(first,'accepted','first accepted')
 assert.equal(variables.last_command,'Pending: second')
 inst.finishCommand(second,'unknown','second outcome unknown')
 assert.equal(variables.last_command_status,'unknown')
 await inst.destroy()
 const before={...variables}
 await inst.panelSleep(true)
 inst.finishCommand(second,'accepted','late second')
 assert.deepEqual(variables,before)
})

test('authentication and configuration faults immediately replace a previously ready diagnosis',async(t)=>{
 const {inst,variables}=await instance(t)
 inst.ingest(status('boot-a',1))
 assert.equal(variables.diagnostic_status,'READY')
 let redraws=0;inst.checkFeedbacks=()=>{redraws++}
 const {InstanceStatus}=await import('@companion-module/base')
 inst.setFault(InstanceStatus.AuthenticationFailure,'passphrase rejected')
 assert.equal(variables.diagnostic_status,'AUTH ERROR')
 assert.equal(inst.diagnosticView().status,'AUTH ERROR')
 assert(redraws>0,'the value feedback behind a linked diagnostic must be re-evaluated')
 inst.setFault(InstanceStatus.BadConfig,'passphrase required')
 assert.equal(variables.diagnostic_status,'CONFIG ERROR')
 inst.ingest(status('boot-a',2))
 assert.equal(variables.diagnostic_status,'READY')
})

test('duplicate ordered heartbeats retry a failed table pull using the accepted target version',async(t)=>{
 const {inst}=await instance(t)
 let pulls=0;inst.refreshTable=async()=>{pulls++;return false}
 const current=status('boot-a',5,{tableVersion:2})
 inst.ingest(current)
 assert.equal(pulls,1)
 inst.ingest(current)
 assert.equal(pulls,2,'same-sequence contact must retry knowledge that never arrived')
 inst.tableVersion=2
 inst.ingest(status('boot-a',4,{tableVersion:99}))
 assert.equal(pulls,2,'an older observation cannot pick a different target table')
})

test('a table response already in flight is followed up when the accepted target moved',async(t)=>{
 const {inst}=await instance(t)
 inst.config.passphrase='fake'
 const rows=inst.states
 const requests=[];t.mock.method(globalThis,'fetch',()=>new Promise(resolve=>requests.push(resolve)))
 const v2=status('boot-a',2,{tableVersion:2}),v3=status('boot-a',3,{tableVersion:3})
 inst.ingest(v2)
 const first=inst.tablePromise
 inst.ingest(v3)
 assert.equal(requests.length,1,'table pulls remain single-flight')
 requests[0](Response.json({version:2,states:rows}))
 await first
 inst.ingest(v3)
 assert.equal(requests.length,2)
 const second=inst.tablePromise
 requests[1](Response.json({version:3,states:rows}))
 await second
 assert.equal(inst.tableVersion,3)
})
