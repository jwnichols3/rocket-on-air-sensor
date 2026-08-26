// Browser tests for the panel's config page (#50).
//
// WHY A BROWSER. The host tests (../test_page.cpp) assert on the HTML the firmware emits.
// They cannot reach the two things that only exist once a browser has parsed it:
//
//   1. WHAT A FORM ACTUALLY SERIALISES. "The colour picker carries no name" is a string
//      assertion in C++; "the picker cannot post" is a claim about FormData. Only the
//      browser settles it, and the gap between those two was where D-71's third defect hid.
//   2. THE GUARDED MIRROR. The picker is SEEDED with the server's value, so an unguarded
//      mirror writes that value into the posting field on any input event - Firefox fires
//      `input` while its colour dialog previews, and macOS NSColorPanel has no cancel at
//      all. Merely LOOKING at the picker would pin the server's current value as a
//      permanent override. There is no way to test that without events.
//
// Also checks the geometry, because "the glass is at the firmware's coordinates" was a
// claim three times over in #50 and was wrong the first two. `*` does not match
// pseudo-elements; that one selector put lit pixels inside the reserved diagnostics band.
//
// Runs against a page fetched from the LIVE DEVICE if one is reachable, and otherwise
// against the committed capture. Never silently skips - it says which it used.

import { chromium } from 'playwright'
import { readFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..')
const DEVICE = process.env.ONAIR_DEVICE || '10.42.12.77'
const AUTH = 'Basic ' + Buffer.from('rocket:ESP32').toString('base64')

let checks = 0, failures = 0, current = ''
const test = (name) => { current = name; console.log('- ' + name) }
const check = (cond, detail = '') => {
  checks++
  if (!cond) {
    failures++
    console.log(`  FAIL  ${current}${detail ? '\n        ' + detail : ''}`)
  }
}

// ---- get the page and its assets ------------------------------------------------------
async function fromDevice() {
  const grab = async (path, headers = {}) => {
    const res = await fetch(`http://${DEVICE}${path}`, { headers, signal: AbortSignal.timeout(4000) })
    if (!res.ok) throw new Error(`${path} -> ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }
  const html = (await grab('/onair/config?edit=interruptible', { Authorization: AUTH })).toString()
  // The assets come back gzipped with no transfer decoding, because fetch only auto-decodes
  // what it asked for; ask for identity and gunzip explicitly so this is unambiguous.
  const css = gunzipSync(await grab('/onair.css'))
  const js = gunzipSync(await grab('/onair.js'))
  return { html, css: css.toString(), js: js.toString(), source: `live device ${DEVICE}` }
}

function fromCapture() {
  const dir = join(REPO, 'docs/design/esp32-config-2026-08-26/live')
  const html = readFileSync(join(dir, 'technical-dark.html'), 'utf8')
  return {
    html,
    css: readFileSync(join(REPO, 'firmware/assets/onair.css'), 'utf8'),
    js: readFileSync(join(REPO, 'firmware/assets/onair.js'), 'utf8'),
    source: 'committed capture + firmware/assets (device not reachable)',
  }
}

let fixture
try {
  fixture = await fromDevice()
} catch (err) {
  const dir = join(REPO, 'docs/design/esp32-config-2026-08-26/live/technical-dark.html')
  if (!existsSync(dir)) {
    console.error(`no device at ${DEVICE} (${err.message}) and no committed capture at ${dir}`)
    process.exit(1)
  }
  fixture = fromCapture()
}
console.log(`onair browser tests\nfixture: ${fixture.source}\n`)

// Serve the three files so relative asset paths resolve exactly as they do on the device.
const page_html = fixture.html.replace(/\/onair\.css/g, 'onair.css').replace(/\/onair\.js/g, 'onair.js')
const server = createServer((req, res) => {
  const send = (type, body) => { res.writeHead(200, { 'Content-Type': type }); res.end(body) }
  if (req.url.startsWith('/onair.css')) return send('text/css', fixture.css)
  if (req.url.startsWith('/onair.js')) return send('text/javascript', fixture.js)
  return send('text/html; charset=utf-8', page_html)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}/`

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1000, height: 1100 } })
await page.goto(base)
await page.waitForFunction(() => !!document.querySelector('.ed'))

// =========================================================================================
// 1. WHAT THE FORM ACTUALLY POSTS
// =========================================================================================
const serialise = () =>
  page.evaluate(() => Object.fromEntries(new FormData(document.querySelector('form.ed'))))

test('an untouched row posts empty label and colours - it follows the server')
{
  const data = await serialise()
  check(data.id === 'interruptible', `id was ${data.id}`)
  check(data.label === '', `label should be empty, was "${data.label}"`)
  check(data.color === '', `color should be empty, was "${data.color}"`)
  check(data.bgcolor === '', `bgcolor should be empty, was "${data.bgcolor}"`)
  check(!('busy' in data), 'a busy field would make handle_action refuse the whole POST')
}

test('no colour picker is serialisable - none of them carries a name')
{
  const names = await page.$$eval('input[type=color]', (els) => els.map((e) => e.getAttribute('name')))
  check(names.length > 0, 'the editor should offer pickers')
  check(names.every((n) => n === null), `every picker must be unnamed, got ${JSON.stringify(names)}`)
}

// =========================================================================================
// 2. THE GUARDED MIRROR - D-71's third door into the colour trap
// =========================================================================================
const pick = async (which, value) => {
  const sel = `.f:has(input[name=${which}]) input[type=color]`
  await page.$eval(sel, (el, v) => {
    el.value = v
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
}

test('opening the picker and choosing the value already there posts NOTHING')
{
  // The whole point. Firefox fires `input` during a live preview the operator then cancels;
  // macOS NSColorPanel offers no cancel at all. An unguarded mirror would pin #e8a317 here.
  await page.reload(); await page.waitForFunction(() => !!document.querySelector('.ed'))
  await pick('bgcolor', '#e8a317')          // the server's own value
  const data = await serialise()
  check(data.bgcolor === '', `merely looking at the picker must not override; got "${data.bgcolor}"`)
}

test('picking a genuinely different colour DOES post it')
{
  await pick('bgcolor', '#3b5bdb')
  const data = await serialise()
  check(data.bgcolor === '#3b5bdb', `a real choice must post; got "${data.bgcolor}"`)
}

test('picking the server value back returns the row to following the server')
{
  await pick('bgcolor', '#e8a317')
  const data = await serialise()
  check(data.bgcolor === '', `picking the server colour clears the override; got "${data.bgcolor}"`)
}

test('the Follow button blanks the field and resyncs the picker')
{
  await pick('bgcolor', '#3b5bdb')
  await page.click('button[data-follow=bgcolor]')
  const data = await serialise()
  check(data.bgcolor === '', 'Follow must clear the posting field')
  const swatch = await page.$eval('.f:has(input[name=bgcolor]) input[type=color]', (e) => e.value)
  check(swatch === '#e8a317', `and resync the picker to the server value; got ${swatch}`)
}

// =========================================================================================
// 3. RECOVERY IS NEVER BLOCKED
// =========================================================================================
test('a half-typed hex blocks Save but NOT the control that puts the row back')
{
  await page.reload(); await page.waitForFunction(() => !!document.querySelector('.ed'))
  await page.fill('input[name=bgcolor]', '6a0dad')   // a plausible slip: no leading #
  const valid = await page.$eval('form.ed', (f) => f.checkValidity())
  check(valid === false, 'native validation should reject a bad hex')
  const clearOk = await page.$eval(
    'form.ed button[value=clear]',
    (b) => b.hasAttribute('formnovalidate'))
  check(clearOk, 'the clear control must carry formnovalidate, or recovery is jammed')
}

// =========================================================================================
// 4. THE GLASS IS AT THE FIRMWARE'S COORDINATES
//
// A pseudo-element has no getBoundingClientRect, and getComputedStyle gives the SPECIFIED
// width, not the rendered box - so a naive check here reads the CSS back to itself and
// passes under exactly the defect it is meant to catch. Verified: shortening the selector to
// `*` left every raw-width assertion green.
//
// So the effective outer size is reconstructed the way the browser lays it out: under
// content-box the borders sit OUTSIDE the declared width, under border-box they do not.
// That is what makes these fail when box-sizing stops reaching ::before.
// =========================================================================================
const glassBox = () =>
  page.evaluate(() => {
    const g = document.querySelector('.ed .g')
    const before = getComputedStyle(g, '::before')
    const gb = g.getBoundingClientRect()
    // The glass is scaled; divide back out to firmware pixels.
    const scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--glass-scale')) || 1
    const bw = parseFloat(before.borderTopWidth) || 0
    const bl = parseFloat(before.borderLeftWidth) || 0
    // content-box puts the border outside the declared width; border-box does not.
    const outset = before.boxSizing === 'content-box' ? 1 : 0
    return {
      shape: g.dataset.shape,
      scale,
      width: parseFloat(before.width) + outset * (bl * 2),
      height: parseFloat(before.height) + outset * (bw * 2),
      left: parseFloat(before.left),
      top: parseFloat(before.top),
      borderTop: bw,
      boxSizing: before.boxSizing,
      glassW: Math.round(gb.width / scale),
      glassH: Math.round(gb.height / scale),
    }
  })

test('the glass is 128x64, the panel\'s real size')
{
  const box = await glassBox()
  check(box.glassW === 128, `width ${box.glassW}`)
  check(box.glassH === 64, `height ${box.glassH}`)
}

test('border-box reaches the pseudo-element - the D-71 geometry defect')
{
  const box = await glassBox()
  check(box.boxSizing === 'border-box',
    `::before must be border-box or every shape inflates by its border; got ${box.boxSizing}`)
}

test('CALM HEAVY is rectangle(0,0,128,48), not 130x50')
{
  await page.evaluate(() => { document.querySelector('.ed .g').dataset.shape = '1' })
  const box = await glassBox()
  check(box.width === 128, `outer frame width should be 128, got ${box.width}`)
  check(box.height === 48, `outer frame height should be 48, got ${box.height}`)
  check(box.top + box.height <= 49,
    `the frame must stop above the reserved y=49 diagnostics band; ends at ${box.top + box.height}`)
}

test('CALM LIGHT is filled_circle(64,24,22) - 44px across at (42,2), clear of the band')
{
  await page.evaluate(() => { document.querySelector('.ed .g').dataset.shape = '2' })
  const box = await glassBox()
  check(box.width === 44, `ring should be 44px across, got ${box.width}`)
  check(box.left === 42, `ring left edge should be 42, got ${box.left}`)
  check(box.borderTop === 7, `ring stroke should be 7px (22 - 15), got ${box.borderTop}`)
  const bottom = box.top + box.height
  check(bottom <= 49, `the ring must not enter the reserved band; it ends at y=${bottom}`)
  // Centre must be (64,24), the firmware's own.
  check(box.left + box.width / 2 === 64, `centre x should be 64, got ${box.left + box.width / 2}`)
  check(box.top + box.height / 2 === 24, `centre y should be 24, got ${box.top + box.height / 2}`)
}

test('CALM LIGHT draws its label at 11px unconditionally - label_font is not applied there')
{
  // elegoo-esp32.yaml:661 hardcodes id(status_text). This is why INTERRUPTIBLE genuinely
  // collides with the ring on the real glass, and a miniature that tidies it away is lying.
  await page.evaluate(() => {
    const g = document.querySelector('.ed .g')
    g.dataset.shape = '2'
    g.querySelector('b').className = 'lg'   // even WITH the big-font class
  })
  const size = await page.$eval('.ed .g b', (b) => getComputedStyle(b).fontSize)
  check(size === '11px', `CALM LIGHT must stay 11px even with .lg set; got ${size}`)
}

test('BUSY and CALM HEAVY do honour label_font: 30px at <= 8 characters')
{
  const big = await page.evaluate(() => {
    const g = document.querySelector('.ed .g')
    g.dataset.shape = '0'
    const b = g.querySelector('b')
    b.className = 'lg'
    return getComputedStyle(b).fontSize
  })
  check(big === '30px', `BUSY with a short label should be 30px; got ${big}`)
  const small = await page.evaluate(() => {
    const b = document.querySelector('.ed .g b')
    b.className = ''
    return getComputedStyle(b).fontSize
  })
  check(small === '14px', `and 14px above 8 characters; got ${small}`)
}

test('the scaled glass does not paint outside its container')
{
  // The `.gw` is a <span>; an inline box ignores width and height, and that is exactly how
  // the glass ended up painting over the luminance readout on the first flash.
  await page.reload(); await page.waitForFunction(() => !!document.querySelector('.ed'))
  const overflow = await page.evaluate(() => {
    const wrap = document.querySelector('.ed .gw')
    const w = wrap.getBoundingClientRect()
    const lum = document.querySelector('.ed .lum')
    if (!lum) return { display: getComputedStyle(wrap).display, overlap: false }
    const l = lum.getBoundingClientRect()
    return { display: getComputedStyle(wrap).display, overlap: l.top < w.bottom - 1 }
  })
  check(overflow.display !== 'inline', `.gw must not be inline; got ${overflow.display}`)
  check(!overflow.overlap, 'the glass must not overlap the luminance readout beneath it')
}

// =========================================================================================
// 5. THE PAGE WITHOUT JAVASCRIPT
// =========================================================================================
test('with scripting off the page is still fully usable')
{
  const noJs = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1000, height: 1100 } })
  const p2 = await noJs.newPage()
  await p2.goto(base)
  const data = await p2.evaluate(() => Object.fromEntries(new FormData(document.querySelector('form.ed'))))
  check(data.label === '' && data.color === '' && data.bgcolor === '',
    'follow-the-server must hold with no JS - the server rendered it that way')
  check(!('busy' in data), 'and still no busy field')
  const controls = await p2.$$eval('form.ed button[name=action]', (b) => b.map((x) => x.value))
  check(controls.includes('save') && controls.includes('clear'),
    'Save and Follow server are ordinary submits, so they work without scripting')
  // The pill is a :has() CSS rule, not JS - it must still say the right thing.
  const pill = await p2.$eval('.f:has(input[name=bgcolor]) .pill',
    (e) => getComputedStyle(e, '::after').content)
  check(/follows server/.test(pill), `the pill must read "follows server" with no JS; got ${pill}`)
  await noJs.close()
}

test('the pill flips to "overridden here" when the field has a value')
{
  await page.reload(); await page.waitForFunction(() => !!document.querySelector('.ed'))
  await page.fill('input[name=bgcolor]', '#3b5bdb')
  const pill = await page.$eval('.f:has(input[name=bgcolor]) .pill',
    (e) => getComputedStyle(e, '::after').content)
  check(/overridden here/.test(pill), `got ${pill}`)
}

// =========================================================================================
// 6. NOTHING IS FETCHED
// =========================================================================================
test('the page makes no request to anything but the device')
{
  const external = []
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 1100 } })
  const p3 = await ctx.newPage()
  p3.on('request', (r) => { if (!r.url().startsWith(base)) external.push(r.url()) })
  await p3.goto(base)
  await p3.waitForTimeout(300)
  check(external.length === 0, `external requests: ${JSON.stringify(external)}`)
  await ctx.close()
}

// =========================================================================================
// 7. THE LUMINANCE READOUT AGREES WITH THE FIRMWARE
// =========================================================================================
test('the readout uses the firmware\'s own Rec.601 integer, not a rounded double')
{
  await page.reload(); await page.waitForFunction(() => !!document.querySelector('.ed'))
  const cases = [
    ['#0b6e2e', 73], ['#c1121f', 71], ['#e8a317', 167], ['#6a0dad', 59],
    ['#1a1a1a', 26], ['#3b5bdb', 96], ['#ffffff', 255], ['#000000', 0],
    // The coefficients sum to exactly 1000, so #808080 is exactly 128 - which makes it the
    // boundary case worth having: it proves the threshold is >= and not >.
    ['#7f7f7f', 127], ['#808080', 128], ['#818181', 129],
  ]
  for (const [hex, want] of cases) {
    await page.fill('input[name=bgcolor]', hex)
    const text = await page.$eval('.ed .lum .cap', (e) => e.textContent)
    const got = parseInt(text.match(/luminance\s*(\d+)/)[1], 10)
    check(got === want, `${hex}: page says ${got}, firmware says ${want}`)
  }
}

test('the 128 line is where the readout says the shape changes')
{
  await page.fill('input[name=bgcolor]', '#7f7f7f')     // 127, one under the line
  let t = await page.$eval('.ed .lum .cap', (e) => e.textContent)
  check(/open ring/.test(t), `127 should draw the ring; got "${t}"`)
  check(await page.$eval('.ed .g', (g) => g.dataset.shape) === '2', 'and the glass should agree')

  // EXACTLY 128. The firmware's test is `>= 128`, so this must draw the FRAME. An
  // off-by-one here would be invisible on every colour except this one.
  await page.fill('input[name=bgcolor]', '#808080')
  t = await page.$eval('.ed .lum .cap', (e) => e.textContent)
  check(/heavy double frame/.test(t), `128 is ON the line and draws the frame; got "${t}"`)
  check(await page.$eval('.ed .g', (g) => g.dataset.shape) === '1', 'and the glass should agree')
}

test('an invalid hex says nothing will be saved rather than showing a stale shape')
{
  await page.fill('input[name=bgcolor]', '#12')
  const t = await page.$eval('.ed .lum .cap', (e) => e.textContent)
  check(/nothing will be saved/.test(t), `got "${t}"`)
}

await browser.close()
server.close()

console.log(`\n${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
