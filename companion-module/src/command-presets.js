// Keep the observed-state face while adding command feedback as independent native layers.
// The progress helper owns time and outcomes. This builder only binds its value feedbacks.
const AMBER = 0xffbf00
const DARK = 0x111111
const WHITE = 0xffffff
const FULL = { x: 0, y: 0, width: 100, height: 100 }
const expression = (value) => ({ isExpression: true, value })
const variableName = (kind, field) => `command_${kind}_${field}`
const reference = (kind, field) => `$(local:${variableName(kind, field)})`
const local = (kind, field) => expression(reference(kind, field))
const png = (value) => value ? (value.startsWith('data:') ? value : `data:image/png;base64,${value}`) : null

// Match Companion 5.1.1's ConvertLegacyStyleToElements.ts for the styles these
// presets already use. Numeric legacy sizes account for the default top bar.
function font(style, base) {
 if (style.size === 'auto') return { fontsize: 100, fontsizeAllowShrink: true }
 const topbar = style.show_topbar ?? base.show_topbar ?? true
 return { fontsize: Number((Number(style.size) * (topbar ? 2.1 : 1 / 0.6)).toFixed(1)), fontsizeAllowShrink: false }
}
function alignment(value) {
 const [halign, valign] = value.split(':')
 return { halign, valign }
}
function textSize(style, base, kind) {
 const size = font(style, base)
 if (kind !== 'panel') return size
 // While the panel overlay is present, a word-only face must fit its smaller
 // observed-state band. The idle font and feedback sizing remain unchanged.
 return {
  fontsize: expression(`${reference(kind, 'visible')} ? 100 : ${size.fontsize}`),
  fontsizeAllowShrink: expression(`${reference(kind, 'visible')} ? true : ${size.fontsizeAllowShrink}`),
 }
}
function styleProperties(style, base, kind) {
 const changes = []
 const add = (elementId, props) => {
  for (const [elementProperty, override] of Object.entries(props)) changes.push({ elementId, elementProperty, override })
 }
 if (style.text !== undefined) add('actual_text', { text: { isExpression: !!style.textExpression, value: style.text } })
 if (style.size !== undefined) add('actual_text', textSize(style, base, kind))
 if (style.color !== undefined) add('actual_text', { color: style.color })
 if (style.bgcolor !== undefined) add('actual_background', { color: style.bgcolor })
 if (style.png64 !== undefined) add('actual_image', { base64Image: png(style.png64) })
 if (style.alignment !== undefined) add('actual_text', alignment(style.alignment))
 if (style.pngalignment !== undefined) add('actual_image', alignment(style.pngalignment))
 if (style.show_topbar !== undefined) add('canvas', { decoration: style.show_topbar ? 'topbar' : 'none' })
 return changes
}
function observedBounds(kind) {
 if (kind !== 'panel') return FULL
 const when = (yes, no) => expression(`${reference(kind, 'visible')} ? ${yes} : ${no}`)
 // Header ends at 20%, observed face spans 23..67%, footer starts at 70%.
 // Those non-overlapping bands remain separate at the real 72px key size.
 return { x: when(22, 0), y: when(23, 0), width: when(56, 100), height: when(44, 100) }
}
function observedElements(style, kind) {
 const known = kind === 'panel' ? { enabled: local(kind, 'known') } : {}
 const elements = [
  { type: 'box', id: 'actual_background', ...FULL, color: 0x000000 },
  { type: 'image', id: 'actual_image', ...observedBounds(kind), ...known, base64Image: null, fillMode: 'fit', halign: 'center', valign: 'center' },
  { type: 'text', id: 'actual_text', ...observedBounds(kind), ...known, text: '', fontsize: 100, fontsizeAllowShrink: true,
   color: WHITE, halign: 'center', valign: 'center' },
 ]
 for (const change of styleProperties(style, style, kind)) {
  const element = elements.find(({ id }) => id === change.elementId)
  if (element) element[change.elementProperty] = change.override
 }
 if (kind === 'panel') {
  const unknown = expression(`!${reference(kind, 'known')}`)
  elements.push(
   { type: 'box', id: 'actual_unknown_background', ...FULL, color: DARK, enabled: unknown },
   { type: 'text', id: 'actual_unknown', ...observedBounds(kind), text: '?', color: WHITE,
    fontsize: 100, fontsizeAllowShrink: true, enabled: unknown },
  )
 }
 return elements
}
function progressVariable(kind, field) {
 return { variableName: variableName(kind, field), variableType: 'feedback', feedbackId: 'command_progress_value', options: { kind, field } }
}
function pendingElements(kind) {
 const enabled = local(kind, 'visible')
 const elements = []
 if (kind === 'panel') {
  const opacity = expression(`${reference(kind, 'pulsing')} ? 45 + 55 * oscillate(1500, "sine") : 100`)
  elements.push(
   { type: 'box', id: 'command_header_background', x: 2, y: 2, width: 96, height: 18, color: DARK, enabled },
   { type: 'text', id: 'command_header', x: 5, y: 3, width: 90, height: 16, text: local(kind, 'header'),
    color: WHITE, fontsize: 100, fontsizeAllowShrink: true, enabled },
   { type: 'box', id: 'command_footer_background', x: 2, y: 70, width: 96, height: 28, color: DARK, enabled },
   { type: 'text', id: 'command_caption', x: 5, y: 71, width: 90, height: 17, text: local(kind, 'caption'),
    color: WHITE, fontsize: 100, fontsizeAllowShrink: true, enabled },
   { type: 'box', id: 'command_track', x: 6, y: 91, width: 88, height: 5, color: 0x505050, enabled },
   { type: 'gauge', id: 'command_drain', x: 6, y: 91, width: 88, height: 5, orientation: 'horizontal', min: 0, max: 1, origin: 0,
    value: expression(`${reference(kind, 'pulsing')} ? 1 : ${reference(kind, 'fraction')}`),
    fillEnabled: true, fillWidth: 100, stops: [{ value: 0, color: AMBER, gradient: false }],
    markerEnabled: false, trackStyle: 'transparent', opacity, enabled },
  )
 }
 elements.push({ type: 'box', id: 'command_edge', ...FULL, color: '#00000000', borderWidth: 2,
  borderColor: AMBER, borderPosition: 'inside', enabled })
 return elements
}
function enhance(preset, kind) {
 if (preset?.type !== 'simple') return preset
 const { style, feedbacks, localVariables = [], ...rest } = preset
 const fields = kind === 'panel' ? ['visible', 'header', 'caption', 'fraction', 'pulsing', 'known'] : ['visible']
 const observedFeedbacks = kind === 'panel'
  ? [...feedbacks, ...feedbacks.filter(({ feedbackId }) => feedbackId === 'panel_asleep').map((feedback) => ({
   ...feedback, feedbackId: 'panel_last_seen_asleep',
  }))]
  : feedbacks
 return {
  ...rest, type: 'layered',
  canvas: { decoration: typeof style.show_topbar === 'boolean' ? (style.show_topbar ? 'topbar' : 'none') : 'default', showStatusIcons: 'default' },
  localVariables: [...localVariables, ...fields.map((field) => progressVariable(kind, field))],
  elements: [...observedElements(style, kind), ...pendingElements(kind)],
  feedbacks: observedFeedbacks.map(({ style: feedbackStyle = {}, ...feedback }) => ({
   ...feedback, styleOverrides: styleProperties(feedbackStyle, style, kind),
  })),
 }
}

/** A pure, targeted transformation: preserve actions, template variables and feedback priority. */
export function enhanceCommandPresets(presets) {
 const result = { ...presets }
 for (const key of ['panel_toggle', 'panel_toggle_words']) if (presets[key]) result[key] = enhance(presets[key], 'panel')
 for (const key of ['state_cycle', 'state_cycle_words']) if (presets[key]) result[key] = enhance(presets[key], 'state')
 return result
}
