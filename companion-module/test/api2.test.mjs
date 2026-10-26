import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, cp, copyFile, readFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { InstanceWrapper } from '@companion-module/host'
import { startFakeServer } from './fake-server.mjs'

async function boot(t, entry = '../src/index.js') {
 const { default: OnAir, UpgradeScripts } = await import(entry)
 assert.equal(typeof OnAir, 'function', 'API 2 host imports a default constructor, not a self-starting entrypoint')
 assert(Array.isArray(UpgradeScripts))
 const server = startFakeServer()
 const port = await server.listen()
 t.after(() => server.close())
 const seen = { variables: {}, presets: {}, sections: [], actions: [], feedbacks: [] }
 const host = {
  setStatus: () => {},
  setActionDefinitions: (v) => { seen.actions = v },
  setFeedbackDefinitions: (v) => { seen.feedbacks = v },
  setVariableDefinitions: (defs, values) => { seen.variableDefinitions=defs; for (const v of values) seen.variables[v.id]=v.value },
  setVariableValues: (values) => { for (const v of values) seen.variables[v.id]=v.value },
  setPresetDefinitions: (sections, presets) => { seen.sections=sections; seen.presets=presets },
  setCompositeElementDefinitions: () => {}, updateFeedbackValues: () => {}, saveConfig: () => {},
  sendOSC: () => {}, recordAction: () => {}, setCustomVariable: () => {},
 }
 const wrapper = new InstanceWrapper('onair-test', host, OnAir, UpgradeScripts, '2.2.0')
 await wrapper.init({ label:'On_Air', isFirstInit:false, config:{host:'127.0.0.1',port:String(port),passphrase:'test-pass'}, secrets:{}, lastUpgradeIndex:-1 })
 t.after(() => wrapper.destroy())
 return {wrapper,server,seen}
}

test('real API 2 host accepts definitions, linked preset structure, and existing action IDs', async(t)=>{
 const {wrapper,server,seen}=await boot(t)
 assert.equal(seen.variables.state,'available')
 assert(seen.variableDefinitions.some(v=>v.id==='module_version'))
 const referenced=seen.sections.flatMap(s=>s.definitions)
 assert(referenced.includes('state_cycle'))
 assert(referenced.includes('panel_toggle'))
 assert(seen.presets.state_cycle)
 assert.equal(seen.presets.panel_toggle.type,'layered')
 assert(seen.presets.panel_toggle.elements.some(e=>e.type==='gauge'&&e.orientation==='horizontal'))
 assert.equal(seen.presets.panel_toggle.category,undefined)
 assert.equal(seen.presets.diagnostics.type,'layered')
 const result=await wrapper.executeAction({id:'existing-action',controlId:'bank:1-2-1',actionId:'set_state',options:{state:'on-air'}},undefined)
 assert.equal(result.success,true)
 assert.equal(server.writes.at(-1).id,'on-air')
 const varsBefore=Object.keys(seen.variables)
 assert(varsBefore.includes('diagnostic_status'))
})

test('API 2 upgrades only legacy interpolated set-state options and preserves placed IDs and styles', async(t)=>{
 const {wrapper}=await boot(t)
 const plain={id:'plain',controlId:'bank:1-2-1',actionId:'cycle_state',options:{ring:{isExpression:false,value:['available','on-air']}},upgradeIndex:-1}
 const custom={id:'custom',controlId:'bank:1-2-1',actionId:'set_state',options:{state:{isExpression:false,value:'prefix-$(custom:row)'}},upgradeIndex:-1}
 const expression={id:'expression',controlId:'bank:1-2-1',actionId:'set_state',options:{state:{isExpression:true,value:'$(custom:row)'}},upgradeIndex:-1}
 const feedback={id:'sleep-copy',controlId:'bank:1-2-2',feedbackId:'panel_asleep',options:{},isInverted:{isExpression:false,value:false},upgradeIndex:-1}
 const result=await wrapper.upgradeActionsAndFeedbacks(-1,[plain,custom,expression],[feedback])
 assert.equal(result.updatedActions.length,3)
 assert.deepEqual(result.updatedActions.find(a=>a.id==='custom').options.state,{isExpression:true,value:'"" + "prefix-" + $(custom:row)'})
 assert.deepEqual(result.updatedActions.find(a=>a.id==='plain').options,plain.options)
 assert.deepEqual(result.updatedActions.find(a=>a.id==='expression').options,expression.options)
 assert.deepEqual(result.updatedFeedbacks[0].options,feedback.options)
 assert.equal(result.updatedFeedbacks[0].id,feedback.id)
})

test('diagnostics uses independent status and command outcomes without inventing physical confirmation', async(t)=>{
 const {wrapper,server,seen}=await boot(t)
 assert.equal(seen.variables.diagnostic_status,'READY')
 await wrapper.executeAction({id:'wake',controlId:'bank:1-2-2',actionId:'panel_sleep',options:{}},undefined)
 assert.equal(seen.variables.last_command_status,'accepted')
 assert.match(seen.variables.last_command,/delivered/)
 server.setConfirmed('unknown')
 server.setConfirmedReason('asleep')
 await new Promise(r=>setTimeout(r,1100))
 assert.equal(seen.variables.diagnostic_status,'ASLEEP')
 server.setPanelSleepStatus(501)
 await wrapper.executeAction({id:'wake',controlId:'bank:1-2-2',actionId:'panel_wake',options:{}},undefined)
 assert.equal(seen.variables.last_command_status,'rejected')
 assert.match(seen.variables.last_command,/501/)
})


test('the actual ESM bundle loads through the real API 2 host and reports its packaged identity', async(t)=>{
 const repo=fileURLToPath(new URL('../../',import.meta.url))
 const root=await mkdtemp(join(tmpdir(),'onair-api2-bundle-'))
 t.after(()=>rm(root,{recursive:true,force:true}))
 const module=join(root,'companion-module')
 await mkdir(module,{recursive:true})
 await symlink(join(repo,'node_modules'),join(root,'node_modules'))
 await cp(join(repo,'companion-module/src'),join(module,'src'),{recursive:true})
 await cp(join(repo,'companion-module/companion'),join(module,'companion'),{recursive:true})
 for(const file of ['package.json','build.mjs'])await copyFile(join(repo,'companion-module',file),join(module,file))
 execFileSync(process.execPath,[join(module,'build.mjs')],{cwd:module,stdio:'pipe'})
 const built=JSON.parse(await readFile(join(module,'dist/package.json'),'utf8'))
 assert.equal(built.type,'module')
 const {seen}=await boot(t,pathToFileURL(join(module,'dist/main.js')).href)
 assert.equal(seen.variables.module_version,built.version)
 assert.equal(seen.variables.module_commit,'unknown','source archive cannot claim a Git revision')
 assert(seen.presets.diagnostics && seen.presets.panel_toggle && seen.presets.state_cycle)
 assert.deepEqual(seen.presets.state_cycle.steps[0].down[0].options.ring,{isExpression:true,value:'$(local:cycle_states)'})
})

test('module manifest declares a valid API 2 connection for the host loader',async()=>{
 const {validateManifest}=await import('@companion-module/base/manifest')
 const manifest=JSON.parse(await readFile(new URL('../companion/manifest.json',import.meta.url),'utf8'))
 validateManifest(manifest,false)
 assert.equal(manifest.type,'connection')
 assert.equal(manifest.runtime.apiVersion,'2.2.0')
})
