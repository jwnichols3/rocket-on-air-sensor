// Browser tests for the admin console (#52, #54).
//
// WHY A BROWSER. server/test/admin-ui.test.ts asserts on the built bundle as TEXT. That
// catches "the source says the right thing" and cannot catch the classes of defect this
// file exists for:
//
//   1. WHETHER A NODE SURVIVES. Both DOM-swap bugs in this console were found by driving
//      the page by hand and neither left a trace - no error, no console entry, the page
//      simply did not respond. Only a browser holding a reference across a poll settles it.
//   2. WHAT A VIEW ACTUALLY SHOWS. "Simple view hides the diagnostics" is a claim about
//      computed visibility, not about source text. A section can be present, styled, and
//      invisible - or absent from the markup and still rendered by script.
//   3. WHETHER A PREFERENCE SURVIVES A RELOAD. That is localStorage plus a boot path, and
//      the boot path is where it would break.
//
// Runs against the REAL server (server/dist/app.js) on a throwaway config, not a stub, so
// the routes, the auth waiver and the poll are the shipped ones.

import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

let checks = 0;
let failures = 0;
let current = '';
const test = (name) => {
  current = name;
  console.log('- ' + name);
};
const check = (cond, detail = '') => {
  checks++;
  if (cond) return;
  failures++;
  console.log(`  FAIL  ${current}${detail ? '\n        ' + detail : ''}`);
};

const { createApp } = await import(join(REPO, 'server', 'dist', 'app.js'));

const dir = await mkdtemp(join(tmpdir(), 'onair-adminui-browser-'));
const app = await createApp({
  configFile: join(dir, 'config.json'),
  stateFile: join(dir, 'state.json'),
  port: 0,
  log: () => {},
});
const base = `http://127.0.0.1:${app.port}`;

const browser = await chromium.launch();
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

const ready = async () => {
  await page.waitForSelector('#console:not([hidden])', { timeout: 10000 });
  await page.waitForFunction(() => document.querySelectorAll('#chips .chip').length > 0);
};

await page.goto(base);
await ready();

// ---------------------------------------------------------------------------

test('the console reaches the logged-in state over the loopback waiver (D-24)');
check(await page.isVisible('#console'), 'the console never appeared');
check(pageErrors.length === 0, `page errors: ${pageErrors.join(' | ')}`);

test('a state chip SURVIVES a poll - the same node, still attached (#54)');
{
  // Tag the live node, force the poll path the way the 5s timer does, then ask whether the
  // very same element object is still in the document. Identity is the test: a rebuilt chip
  // would be a different object holding a different listener, and everything else about the
  // page would look correct.
  await page.evaluate(() => {
    const b = document.querySelector('#chips .chip');
    b.dataset.marked = 'original';
    window.__node = b;
  });

  const before = await page.evaluate(() => document.querySelectorAll('#chips .chip').length);
  await page.evaluate(() => refreshStatus());
  await page.evaluate(() => refreshStatus());
  await page.waitForTimeout(100);

  const verdict = await page.evaluate(() => ({
    sameObject: document.querySelector('#chips .chip') === window.__node,
    stillAttached: document.contains(window.__node),
    markSurvived: window.__node.dataset.marked === 'original',
    count: document.querySelectorAll('#chips .chip').length,
  }));

  check(verdict.stillAttached, 'the chip was detached from the document by a poll');
  check(verdict.sameObject, 'the chip was replaced by a different node - this IS the bug');
  check(verdict.markSurvived, 'the node lost its identity across the poll');
  check(verdict.count === before, `chip count moved: ${before} -> ${verdict.count}`);
}

test('and the click still works after polls have run - the listener came with it');
{
  const stateBefore = await (await fetch(`${base}/status`)).json();
  const target = await page.evaluate(() => {
    const other = [...document.querySelectorAll('#chips .chip')]
      .find((c) => c.dataset.id !== window.__liveId);
    return other ? other.dataset.id : null;
  });
  await page.evaluate(() => refreshStatus());
  await page.click(`#chips .chip[data-id="${target}"]`);
  await page.waitForTimeout(400);
  const stateAfter = await (await fetch(`${base}/status`)).json();
  check(
    stateAfter.updatedAt !== stateBefore.updatedAt || stateAfter.state !== stateBefore.state,
    'the click reached the server not at all - handler lost with the node',
  );
}

test('the pin reads its state at CLICK time, not at build time');
{
  const label = () => page.textContent('#pin');
  const first = (await label()).trim();
  await page.click('#pin');
  await page.waitForTimeout(400);
  const second = (await label()).trim();
  check(first !== second, `the pin label did not change: "${first}" -> "${second}"`);

  await page.click('#pin');
  await page.waitForTimeout(400);
  const third = (await label()).trim();
  check(third === first, `the pin did not toggle back: "${second}" -> "${third}" (wanted "${first}")`);
}

test('an open row editor is not destroyed by a poll');
{
  await page.click('#rail button[data-sec="states"]');
  await page.click('.row .row-actions button:has-text("Edit")');
  await page.waitForSelector('.row-edit input');
  await page.fill('.row-edit input', 'TYPED-WHILE-POLLING');
  await page.evaluate(() => refreshStatus());
  await page.evaluate(() => refreshStatus());
  await page.waitForTimeout(100);
  const survived = await page.inputValue('.row-edit input');
  check(survived === 'TYPED-WHILE-POLLING', `the editor lost its input: got "${survived}"`);
  await page.click('.row-edit button:has-text("Cancel")');
}

// ---------------------------------------------------------------------------
// #52: the rail reveals, the views differ, the preferences persist.

test('every rail entry REVEALS its own section and hides the others (#52)');
{
  await page.click('#view-advanced');
  const ids = await page.$$eval('#rail button', (bs) => bs.map((b) => b.dataset.sec));
  check(ids.length === 5, `expected all five sections in advanced view, got ${ids.join(',')}`);

  for (const id of ids) {
    await page.click(`#rail button[data-sec="${id}"]`);
    const shown = await page.evaluate(
      (want) => [...document.querySelectorAll('.sections section')]
        .filter((s) => !s.hidden)
        .map((s) => s.id),
      id,
    );
    check(
      shown.length === 1 && shown[0] === 'sec-' + id,
      `clicking ${id} should show exactly sec-${id}; showing [${shown.join(',')}]`,
    );
  }
}

test('the rail marks where you are, and no anchor is left to scroll nowhere');
{
  await page.click('#rail button[data-sec="network"]');
  const current = await page.$$eval('#rail button[aria-current="true"]', (b) => b.map((x) => x.dataset.sec));
  check(current.length === 1 && current[0] === 'network', `aria-current: [${current.join(',')}]`);
  // The old rail was five <a href="#status"> against sections id'd sec-status. Every link
  // was inert. There must be no href-based navigation left at all.
  const anchors = await page.$$eval('#rail a', (a) => a.length);
  check(anchors === 0, `${anchors} anchors survive in the rail`);
}

test('SIMPLE view carries only the sections that hold things you set');
{
  await page.click('#view-simple');
  const ids = await page.$$eval('#rail button', (bs) => bs.map((b) => b.dataset.sec));
  check(
    JSON.stringify(ids) === JSON.stringify(['states', 'admin']),
    `simple view rail should be States + Admin, got [${ids.join(',')}]`,
  );
  const statusVisible = await page.evaluate(() => !document.getElementById('sec-status').hidden);
  check(!statusVisible, 'the diagnostics section is still on screen in simple view');
}

test('the command surface is present and identical in BOTH views');
{
  const grab = () => page.evaluate(() => ({
    chips: document.querySelectorAll('#chips .chip').length,
    word: document.getElementById('tally-word').textContent,
    pin: !!document.getElementById('pin').offsetParent,
  }));
  await page.click('#view-simple');
  const simple = await grab();
  await page.click('#view-advanced');
  const advanced = await grab();
  check(simple.chips > 0 && simple.chips === advanced.chips, 'chip count differs between views');
  check(simple.word === advanced.word, 'the tally word differs between views');
  check(simple.pin && advanced.pin, 'the pin is not reachable in both views');
  await page.click('#view-simple');
}

test('the view survives a reload, and it is NOT config (D-80)');
{
  await page.click('#view-advanced');
  const staged = await page.textContent('#staged-count');
  check(staged.trim() === '', `switching view staged a change: "${staged}"`);

  await page.reload();
  await ready();
  const after = await page.$$eval('#view-advanced', (b) => b[0].className);
  check(/\bon\b/.test(after), 'advanced view did not survive the reload');
  await page.click('#view-simple');
}

test('the theme toggle overrides the system preference in BOTH directions');
{
  const theme = () => page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  const start = await theme();
  await page.click('#theme');
  const flipped = await theme();
  check(flipped !== start, `the theme did not change from "${start}"`);
  check(['dark', 'light'].includes(flipped), `unexpected theme "${flipped}"`);
  await page.click('#theme');
  check((await theme()) === start, 'the theme did not toggle back');

  // The icon must follow, or the control lies about what it will do next.
  const sunHidden = await page.evaluate(() => document.getElementById('icon-sun').hidden);
  const moonHidden = await page.evaluate(() => document.getElementById('icon-moon').hidden);
  check(sunHidden !== moonHidden, 'both theme icons are in the same state');
}

test('the theme survives a reload');
{
  const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  await page.click('#theme');
  const chosen = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  await page.reload();
  await ready();
  const after = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  check(after === chosen, `theme was "${chosen}" before reload and "${after}" after`);
  check(after !== before, 'the toggle had no lasting effect at all');
}

test('the body actually repaints - the palette is not defined only in a media query');
{
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  const lightBg = await bg();
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  const darkBg = await bg();
  check(lightBg !== darkBg, `body background did not change: light=${lightBg} dark=${darkBg}`);
}

test('the admin password is masked and the passphrase is not (D-81)');
{
  await page.click('#view-advanced');
  await page.click('#rail button[data-sec="admin"]');
  const types = await page.$$eval('#admin-fields input', (inputs) =>
    inputs.map((i) => [i.previousElementSibling ? i.previousElementSibling.textContent : '', i.type]));
  const pass = types.find(([l]) => /passphrase/i.test(l));
  const admin = types.find(([l]) => /admin password/i.test(l));
  check(pass && pass[1] === 'text', `the passphrase should stay readable, got type=${pass && pass[1]}`);
  check(admin && admin[1] === 'password', `the admin password should be masked, got type=${admin && admin[1]}`);
}

test('a default credential says so, without scolding');
{
  const nagText = await page.$$eval('#admin-fields .nag', (n) => n.map((x) => x.textContent.trim()));
  check(
    nagText.some((t) => /currently set to the default/i.test(t)),
    `expected a default note, got [${nagText.join(' | ')}]`,
  );
  check(
    !nagText.some((t) => /should|must|insecure|change it|warning|risk/i.test(t)),
    `the note is scolding: [${nagText.join(' | ')}]`,
  );
}

test('the Admin section holds the view setting, the password and the reset');
{
  const hasView = await page.evaluate(() => !!document.querySelector('#sec-admin #admin-view'));
  const hasReset = await page.evaluate(() => !!document.querySelector('#sec-admin #factory-reset'));
  const hasPw = await page.evaluate(() =>
    [...document.querySelectorAll('#sec-admin label')].some((l) => /admin password/i.test(l.textContent)));
  check(hasView, 'the view setting is not in the Admin section');
  check(hasReset, 'factory reset is not in the Admin section');
  check(hasPw, 'the admin password is not in the Admin section');
}

test('the Admin view control and the header toggle stay in step');
{
  await page.selectOption('#admin-view', 'simple');
  await page.waitForTimeout(50);
  const headerOn = await page.$$eval('#view-simple', (b) => b[0].className);
  check(/\bon\b/.test(headerOn), 'the header toggle did not follow the Admin setting');
  await page.click('#view-advanced');
  const sel = await page.inputValue('#admin-view');
  check(sel === 'advanced', `the Admin setting did not follow the header toggle: "${sel}"`);
}

test('there is no section called "Light" anywhere on screen (D-78)');
{
  const labels = await page.$$eval('#rail button', (bs) => bs.map((b) => b.textContent.trim()));
  check(
    labels.some((l) => /device connection/i.test(l)),
    `expected a Device connection section, got [${labels.join(', ')}]`,
  );
  check(
    !labels.some((l) => /^light\b/i.test(l)),
    `a section is still called Light: [${labels.join(', ')}]`,
  );
}

// ---------------------------------------------------------------------------
// THE BUSY RULE, as a picture (D-32, D-82). The asymmetry is the whole point.

test('a CALM state on stale evidence does NOT wear its own colour');
{
  // Drive the server to a calm row, then age the evidence past the threshold from the
  // page's side, so the treatment is exercised on real data rather than a fixture.
  const states = await (await fetch(`${base}/config/states`, {
    headers: { authorization: 'Bearer onair' },
  }).then((r) => r.json()).catch(() => ({ states: [] })));
  const calm = (states.states || []).find((r) => !r.busy);
  check(!!calm, 'the seeded table has no calm row to test with');

  const painted = await page.evaluate((row) => {
    liveStatus = { state: row.id, confirmed: row.id, hold: null, source: 'human:test',
                   busy: false, intended: 'off', ageSeconds: 900, stale: true, tableVersion: 1 };
    renderTally();
    const card = document.getElementById('tally');
    return {
      cls: card.className,
      bg: getComputedStyle(card).backgroundColor,
      inline: card.style.background,
    };
  }, calm);

  check(/withheld/.test(painted.cls), `the tally is not withheld: "${painted.cls}"`);
  check(painted.inline === '', `the row's own colour was painted anyway: "${painted.inline}"`);
}

test('a BUSY state on stale evidence KEEPS its own colour - draining it weakens the signal');
{
  const states = await (await fetch(`${base}/config/states`, {
    headers: { authorization: 'Bearer onair' },
  }).then((r) => r.json()).catch(() => ({ states: [] })));
  const busy = (states.states || []).find((r) => r.busy && r.id !== 'unknown');
  check(!!busy, 'the seeded table has no busy row to test with');

  const painted = await page.evaluate((row) => {
    liveStatus = { state: row.id, confirmed: row.id, hold: null, source: 'human:test',
                   busy: true, intended: 'on', ageSeconds: 900, stale: true, tableVersion: 1 };
    renderTally();
    const card = document.getElementById('tally');
    return { cls: card.className, inline: card.style.background };
  }, busy);

  check(/\blit\b/.test(painted.cls), `a stale busy state lost its colour: "${painted.cls}"`);
  check(/hatched/.test(painted.cls), 'a stale busy state is not marked as unconfirmed at all');
  check(painted.inline !== '', 'the busy row was drained - false OFF is worse than false ON');
}

test('and a stale reading always says so, in words, next to the control that fixes it');
{
  const caution = await page.evaluate(() => {
    const c = document.getElementById('caution');
    return { hidden: c.hidden, text: c.textContent };
  });
  check(!caution.hidden, 'the caution band is hidden on stale evidence');
  check(/press a state below/i.test(caution.text), `caution reads: "${caution.text}"`);
}

test('the Device connection section links to the panel, in a new tab (#55)');
{
  await page.click('#view-advanced');
  await page.click('#rail button[data-sec="device"]');
  // The throwaway config has no device address - correctly, a fresh install has not been
  // pointed at a light yet - so give it one before asking what it links to.
  await page.evaluate(() => {
    draft.light.host = '10.42.12.77';
    envInfo = { overrides: [], lightHost: '10.42.12.77' };
    renderFields();
  });
  const links = await page.$$eval('#device-fields .panel-link', (as) =>
    as.map((a) => ({ href: a.getAttribute('href'), target: a.target, rel: a.rel, text: a.textContent.trim() })));

  check(links.length === 2, `expected two panel links, got ${links.length}`);
  check(links.every((l) => l.target === '_blank'), 'a link does not open in a new tab');
  check(
    links.every((l) => /noopener/.test(l.rel) && /noreferrer/.test(l.rel)),
    `rel is wrong: ${links.map((l) => l.rel).join(' | ')}`,
  );
  check(links.some((l) => /\/onair$/.test(l.href || '')), `no status link: ${links.map((l) => l.href).join(', ')}`);
  check(links.some((l) => /\/onair\/config$/.test(l.href || '')), 'no settings link');
  check(links.every((l) => /^http:\/\//.test(l.href || '')), 'a link is not an http URL');
}

test('with NO device address configured, no link is emitted at all');
{
  const emitted = await page.evaluate(() => {
    const keptEnv = envInfo;
    const keptHost = draft.light.host;
    envInfo = { overrides: [], lightHost: null };
    draft.light.host = null;
    renderFields();
    const n = document.querySelectorAll('#device-fields .panel-link').length;
    envInfo = keptEnv; draft.light.host = keptHost; renderFields();
    return n;
  });
  check(emitted === 0, `a dead link was emitted for an unset host: ${emitted}`);
}

test('a host that is not host-shaped never reaches an href');
{
  // The value is operator-set and lands in an href. The SCHEME is ours and only the
  // authority comes from config, but a string that is not host-shaped must not be linked
  // at all rather than trusted to be harmless once prefixed.
  const emitted = await page.evaluate(() => {
    const keptEnv = envInfo;
    const keptHost = draft.light.host;
    envInfo = { overrides: [], lightHost: 'javascript:alert(1)' };
    draft.light.host = 'javascript:alert(1)';
    renderFields();
    const hrefs = [...document.querySelectorAll('#device-fields .panel-link')].map((a) => a.getAttribute('href'));
    envInfo = keptEnv; draft.light.host = keptHost; renderFields();
    return hrefs;
  });
  check(emitted.length === 0, `a non-host was linked: ${emitted.join(', ')}`);
}

test('an ENV-OVERRIDDEN field is read-only and names the variable winning (D-79)');
{
  const shown = await page.evaluate(() => {
    const keptEnv = envInfo;
    envInfo = { overrides: [{ key: 'light.host', variable: 'ONAIR_LIGHT_HOST' }], lightHost: '10.0.0.99' };
    renderFields();
    const input = document.querySelector('#device-fields input');
    const nag = document.querySelector('#device-fields .nag');
    const out = { readOnly: input.readOnly, value: input.value, nag: nag ? nag.textContent : '' };
    envInfo = keptEnv; renderFields();
    return out;
  });
  check(shown.readOnly, 'an overridden field is still editable - saving it would change nothing');
  check(shown.value === '10.0.0.99', `the field should show the EFFECTIVE value, got "${shown.value}"`);
  check(/ONAIR_LIGHT_HOST/.test(shown.nag), `the note should name the variable: "${shown.nag}"`);
  check(/config\.env/.test(shown.nag), `the note should name the file: "${shown.nag}"`);
}

test('and the link follows the OVERRIDE, not the document - a link gets clicked');
{
  const href = await page.evaluate(() => {
    const keptEnv = envInfo;
    const keptHost = draft.light.host;
    draft.light.host = '10.0.0.1';
    envInfo = { overrides: [{ key: 'light.host', variable: 'ONAIR_LIGHT_HOST' }], lightHost: '10.0.0.99' };
    renderFields();
    const a = document.querySelector('#device-fields .panel-link');
    const out = a ? a.getAttribute('href') : null;
    envInfo = keptEnv; draft.light.host = keptHost; renderFields();
    return out;
  });
  check(
    href === 'http://10.0.0.99/onair',
    `the link must name the box the service drives, got "${href}"`,
  );
}

test('no page errors were raised at any point');
check(pageErrors.length === 0, pageErrors.join(' | '));

// ---------------------------------------------------------------------------

await browser.close();
await app.close();
await rm(dir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
