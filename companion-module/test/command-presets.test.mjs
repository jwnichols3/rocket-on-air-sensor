import assert from 'node:assert/strict'
import { test } from 'node:test'
import { InstanceBase } from '@companion-module/base'
import { InstanceWrapper, registerLoggingSink } from '@companion-module/host'
import { enhanceCommandPresets } from '../src/command-presets.js'
import { ICONS } from '../src/icons.js'

const ring = ['available', 'on-air', 'interruptible', 'recording']
const cycle = {
 type: 'simple', category: 'States', name: 'Next state', notes: 'Keep this cycle',
 style: { text: '', size: '14', color: 0xffffff, bgcolor: 0x282828, png64: ICONS.cycle.light },
 localVariables: [{ variableName: 'cycle_states', variableType: 'simple', startupValue: ring }],
 steps: [{ down: [{ actionId: 'cycle_state', options: { ring: { isExpression: true, value: '$(local:cycle_states)' } } }], up: [] }],
 feedbacks: [
  { feedbackId: 'state_is', options: { state: 'on-air' }, headline: 'Owner caption', isInverted: false,
   style: { text: 'ON AIR', size: 'auto', color: 0xffffff, bgcolor: 0xc1121f, png64: ICONS['on-air'].light } },
  { feedbackId: 'connection_lost', options: {}, style: { text: 'NO\nCONTACT', size: '14', color: 0, bgcolor: 0xffbf00, png64: ICONS.cycle.dark } },
  { feedbackId: 'no_data', options: {}, style: { text: 'NO DATA', size: 'auto', color: 0xff00ff, bgcolor: 0x1a1a1a, png64: '' } },
 ],
}
const panel = {
 type: 'simple', category: 'Panel', name: 'Panel toggle', notes: 'Actual glass',
 style: { text: '', size: '14', color: 0, bgcolor: 0xc8c8cd, png64: ICONS.wake.dark },
 steps: [{ down: [{ actionId: 'panel_toggle', options: {} }], up: [] }],
 feedbacks: [{ feedbackId: 'panel_asleep', options: {}, style: { text: '', size: '14', color: 0xffffff, bgcolor: 0, png64: ICONS.sleep.light } }],
}
function fixtures() {
 return structuredClone({ state_cycle: cycle, state_cycle_words: { ...cycle, name: 'Next state words', style: { ...cycle.style, text: 'NEXT\nSTATE', png64: undefined } },
  panel_toggle: panel, panel_toggle_words: { ...panel, name: 'Panel toggle words', style: { ...panel.style, text: 'SCREEN\nON', png64: undefined },
   feedbacks: [{ feedbackId: 'panel_asleep', options: {}, style: { text: 'SCREEN\nOFF', size: '14', color: 0xffffff, bgcolor: 0 } }] },
  unrelated: { ...panel, name: 'Unrelated' },
 })
}
const find = (preset, id) => preset.elements.find((element) => element.id === id)
const literal = (value) => value && typeof value === 'object' && 'value' in value ? value.value : value
const evaluate = (value, vars) => value && typeof value === 'object' && value.isExpression
 ? Function('oscillate', `return (${value.value.replace(/\$\(local:([^)]+)\)/g, (_, name) => JSON.stringify(vars[name]))})`)(() => 0.5)
 : literal(value)

test('only the four command presets become layered, preserving actions, ring, metadata and input', () => {
 const original = fixtures(), snapshot = structuredClone(original), result = enhanceCommandPresets(original)
 assert.deepEqual(original, snapshot)
 assert.equal(result.unrelated, original.unrelated)
 for (const key of ['state_cycle', 'state_cycle_words', 'panel_toggle', 'panel_toggle_words']) {
  const enhanced = result[key], before = original[key]
  assert.equal(enhanced.type, 'layered')
  for (const field of ['category', 'name', 'notes', 'steps']) assert.deepEqual(enhanced[field], before[field])
  assert.deepEqual(enhanced.localVariables.slice(0, before.localVariables?.length ?? 0), before.localVariables ?? [])
 }
 assert.deepEqual(result.state_cycle.localVariables[0].startupValue, ring)
 assert.deepEqual(enhanceCommandPresets(result), result, 'already layered definitions are not enhanced twice')
})

test('state, connection-loss and no-data feedbacks retain order, art, colors and captions', () => {
 const result = enhanceCommandPresets(fixtures()).state_cycle
 assert.deepEqual(result.feedbacks.map(({ feedbackId }) => feedbackId), cycle.feedbacks.map(({ feedbackId }) => feedbackId))
 const observed = Object.fromEntries(result.elements.map((element) => [element.id, { ...element }]))
 for (let i = 0; i < cycle.feedbacks.length; i++) {
  const before = cycle.feedbacks[i], after = result.feedbacks[i]
  for (const field of ['feedbackId', 'options', 'headline', 'isInverted']) assert.deepEqual(after[field], before[field])
  for (const { elementId, elementProperty, override } of after.styleOverrides) observed[elementId][elementProperty] = override
  assert.equal(literal(observed.actual_text.text), before.style.text)
  assert.equal(literal(observed.actual_text.color), before.style.color)
  assert.equal(literal(observed.actual_background.color), before.style.bgcolor)
  assert.equal(literal(observed.actual_image.base64Image), before.style.png64 ? `data:image/png;base64,${before.style.png64}` : null)
 }
 assert.equal(literal(observed.actual_text.text), 'NO DATA', 'reserved-state feedback remains the final authority')
 assert.equal(find(result, 'command_drain'), undefined, 'cycle gets no countdown or altered action behavior')
 assert.deepEqual(find(result, 'actual_image'), { type: 'image', id: 'actual_image', x: 0, y: 0, width: 100, height: 100,
  base64Image: `data:image/png;base64,${cycle.style.png64}`, fillMode: 'fit', halign: 'center', valign: 'center' })
})

test('panel pending layout keeps separate header, observed-state and countdown bands', () => {
 const result = enhanceCommandPresets(fixtures()).panel_toggle
 const pending = { command_panel_visible: true, command_panel_fraction: 0.7, command_panel_pulsing: false }
 const hidden = { ...pending, command_panel_visible: false }
 const header = find(result, 'command_header_background'), image = find(result, 'actual_image'), footer = find(result, 'command_footer_background')
 assert(header.y + header.height < evaluate(image.y, pending))
 assert(evaluate(image.y, pending) + evaluate(image.height, pending) < footer.y)
 assert.equal(evaluate(image.x, hidden), 0); assert.equal(evaluate(image.y, hidden), 0)
 assert.equal(evaluate(image.width, hidden), 100); assert.equal(evaluate(image.height, hidden), 100)
 const gauge = find(result, 'command_drain')
 assert.equal(gauge.orientation, 'horizontal')
 assert.equal(evaluate(gauge.value, pending), 0.7)
 assert.equal(evaluate(gauge.value, { ...pending, command_panel_fraction: 0, command_panel_pulsing: true }), 1, 'overtime breathes as an indeterminate full bar')
 assert.equal(evaluate(gauge.enabled, hidden), false)
 for (const element of result.elements.filter(({ id }) => id.startsWith('command_'))) assert.equal(evaluate(element.enabled, hidden), false)
 for (const key of ['command_header', 'command_caption']) {
  assert.equal(find(result, key).fontsize, 100)
  assert.equal(find(result, key).fontsizeAllowShrink, true)
 }
 assert.equal(literal(find(result, 'actual_image').base64Image), `data:image/png;base64,${panel.style.png64}`)
 assert(!JSON.stringify(result).includes('action_running'), 'pending lifecycle comes from the module, not callback duration')
})

test('word-only observed state and the state-cycle accent retain their independent bindings', () => {
 const result = enhanceCommandPresets(fixtures())
 const panelWords = result.panel_toggle_words
 assert.equal(literal(find(panelWords, 'actual_text').text), 'SCREEN\nON')
 assert.equal(evaluate(find(panelWords, 'actual_text').fontsize, { command_panel_visible: true }), 100)
 assert.equal(evaluate(find(panelWords, 'actual_text').fontsizeAllowShrink, { command_panel_visible: true }), true)
 assert.equal(evaluate(find(panelWords, 'actual_text').fontsize, { command_panel_visible: false }), 29.4)
 const accent = find(result.state_cycle, 'command_edge')
 assert.equal(evaluate(accent.enabled, { command_state_visible: true, command_panel_visible: false }), true)
 assert.equal(evaluate(accent.enabled, { command_state_visible: false, command_panel_visible: true }), false)
 assert.equal(result.state_cycle.localVariables.filter(({ feedbackId }) => feedbackId === 'command_progress_value').length, 1)
})


test('unknown panel presentation uses a neutral question mark and cached dark art has a separate feedback', () => {
 const presets = enhanceCommandPresets(fixtures())
 for (const id of ['panel_toggle', 'panel_toggle_words']) {
  const preset = presets[id]
  const noEvidence = { command_panel_visible: true, command_panel_known: false }
  const lastSeen = { command_panel_visible: true, command_panel_known: true }
  for (const elementId of ['actual_image', 'actual_text']) {
   assert.equal(evaluate(find(preset, elementId).enabled, noEvidence), false)
   assert.equal(evaluate(find(preset, elementId).enabled, lastSeen), true)
  }
  for (const elementId of ['actual_unknown_background', 'actual_unknown']) {
   assert.equal(evaluate(find(preset, elementId).enabled, noEvidence), true)
   assert.equal(evaluate(find(preset, elementId).enabled, lastSeen), false)
  }
  assert.equal(find(preset, 'actual_unknown').text, '?')
  const original = preset.feedbacks.find(({ feedbackId }) => feedbackId === 'panel_asleep')
  const fallback = preset.feedbacks.at(-1)
  assert.equal(fallback.feedbackId, 'panel_last_seen_asleep')
  assert.deepEqual(fallback.styleOverrides, original.styleOverrides)
  assert.deepEqual(fallback.options, original.options)
  assert(preset.localVariables.some(v => v.feedbackId === 'command_progress_value' && v.options.field === 'known'))
 }
 assert.equal(find(presets.state_cycle, 'actual_unknown'), undefined, 'the state-cycle truth model is not altered')
})

test('real SDK2 host accepts layered progress definitions, gauges and style override references', async (t) => {
 const warnings = [], seen = {}
 registerLoggingSink((_source, level, message) => { if (level === 'warn' || level === 'error') warnings.push(message) })
 class ProofModule extends InstanceBase {
  async init() {
   this.setActionDefinitions({ cycle_state: { name: 'Cycle', options: [{ type: 'multidropdown', id: 'ring', label: 'Ring', default: ring, choices: ring.map(id => ({ id, label: id })) }], callback() {} },
    panel_toggle: { name: 'Panel toggle', options: [], callback() {} } })
   this.setFeedbackDefinitions(Object.fromEntries([
    ['state_is', { type: 'boolean', name: 'State', options: [{ type: 'textinput', id: 'state', label: 'State', default: 'on-air' }], defaultStyle: {}, callback: () => false }],
    ...['connection_lost', 'no_data', 'panel_asleep', 'panel_last_seen_asleep'].map(id => [id, { type: 'boolean', name: id, options: [], defaultStyle: {}, callback: () => false }]),
    ['command_progress_value', { type: 'value', name: 'Command progress', options: [
     { type: 'dropdown', id: 'kind', label: 'Kind', default: 'panel', choices: ['panel', 'state'].map(id => ({ id, label: id })) },
     { type: 'dropdown', id: 'field', label: 'Field', default: 'visible', choices: ['visible', 'header', 'caption', 'fraction', 'pulsing', 'known'].map(id => ({ id, label: id })) },
    ], callback: () => false }],
   ]))
   const presets = Object.fromEntries(Object.entries(enhanceCommandPresets(fixtures())).map(([id, { category, ...preset }]) => [id, preset]))
   this.setPresetDefinitions([{ id: 'commands', name: 'Commands', definitions: Object.keys(presets) }], presets)
  }
  async destroy() {}
  async configUpdated() {}
  getConfigFields() { return [] }
 }
 const noop = () => {}
 const host = Object.fromEntries(['setStatus', 'setActionDefinitions', 'setFeedbackDefinitions', 'setVariableDefinitions', 'setVariableValues',
  'setCompositeElementDefinitions', 'updateFeedbackValues', 'saveConfig', 'sendOSC', 'recordAction', 'setCustomVariable'].map(key => [key, noop]))
 host.setPresetDefinitions = (sections, presets) => Object.assign(seen, { sections, presets })
 const wrapper = new InstanceWrapper('progress-proof', host, ProofModule, [], '2.2.0')
 t.after(() => wrapper.destroy())
 await wrapper.init({ label: 'Progress proof', isFirstInit: false, config: {}, secrets: {}, lastUpgradeIndex: -1 })
 assert.equal(Object.keys(seen.presets).length, 5)
 assert.equal(seen.presets.panel_toggle.type, 'layered')
 assert.equal(find(seen.presets.panel_toggle, 'command_drain').type, 'gauge')
 assert.equal(seen.presets.panel_toggle.feedbacks[0].styleOverrides[0].elementId, 'actual_text')
 assert.deepEqual(warnings, [])
})
