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
  }));
  await page.click('#view-simple');
  const simple = await grab();
  await page.click('#view-advanced');
  const advanced = await grab();
  check(simple.chips > 0 && simple.chips === advanced.chips, 'chip count differs between views');
  check(simple.word === advanced.word, 'the tally word differs between views');
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

test('the help icon is a real link to a page that really exists');
{
  // The failure this catches is a help link that 404s - which looks perfectly fine in the
  // console, because nothing about the header changes when its target is gone. So the test
  // does not stop at the href: it FETCHES it and reads what comes back.
  const help = await page.$('#help');
  check(help !== null, 'no help control in the header');

  const href = await page.$eval('#help', (a) => a.getAttribute('href'));
  check(href === '/docs', `help points at "${href}"`);

  // An anchor, not a button. Middle-click, cmd-click and "copy link address" are the whole
  // reason, and a <button> that navigates loses all three without any visible symptom.
  const tag = await page.$eval('#help', (a) => a.tagName);
  check(tag === 'A', `help is a <${tag.toLowerCase()}>, so it cannot be opened in a new tab`);

  // Reachable, and reachable WITHOUT the console's session - the guide is public.
  // Fetches THE HREF, not a path retyped here. Hardcoding '/docs' in the test would let a
  // renamed link keep passing against a URL nothing in the console points at any more.
  const res = await page.evaluate(async () => {
    const r = await fetch(document.getElementById('help').href);
    const text = await r.text();
    // The whole document is searched, not a prefix: the inlined stylesheet comes first and
    // is longer than any slice worth taking, so a prefix check only ever sees the <head>.
    return { status: r.status, type: r.headers.get('content-type'), h1: /<h1>/.test(text), bytes: text.length };
  });
  check(res.status === 200, `following the help link returned ${res.status}`);
  check(/text\/html/.test(res.type ?? ''), `the help link served "${res.type}"`);
  check(res.h1, `the guide came back with no heading in ${res.bytes} bytes - it rendered as nothing`);

  // A control with no accessible name is a mystery circle in a row of mystery circles.
  const label = await page.$eval('#help', (a) => a.getAttribute('aria-label'));
  check(typeof label === 'string' && label.length > 0, 'the help icon has no accessible name');
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
// THE BUSY RULE, as a picture (D-32, D-82), now triggered by THE CONNECTION (D-91).
//
// The asymmetric treatment is unchanged and still judge-verified. What moved is when it
// fires: on our own loss of contact with the service, not on a `stale` flag the server no
// longer sends. `lostContact()` below fakes that by winding back the page's own clock.

const lostContact = (ms) => `lastContactAt = Date.now() - ${ms};`;

test('an OLD WRITE on a LIVE connection is drawn fully lit - the D-91 headline');
{
  // This is the case the whole change exists for. Nothing has written state for two hours,
  // the service is healthy and answering, so the state IS the state and the console says so
  // plainly. The old code drained this to a withheld card on the server's `stale` flag.
  const states = await (await fetch(`${base}/config/states`, {
    headers: { authorization: 'Bearer onair' },
  }).then((r) => r.json()).catch(() => ({ states: [] })));
  const calm = (states.states || []).find((r) => !r.busy);

  const painted = await page.evaluate((row) => {
    lastContactAt = Date.now(); // the service answered just now
    liveStatus = { state: row.id, confirmed: row.id, source: 'human:test',
                   busy: false, intended: 'off', ageSeconds: 7200, tableVersion: 1 };
    renderTally();
    const card = document.getElementById('tally');
    return { cls: card.className, inline: card.style.background,
             eyebrow: document.getElementById('tally-eyebrow').textContent };
  }, calm);

  check(/\blit\b/.test(painted.cls), `a 2-hour-old write on a live link was withheld: "${painted.cls}"`);
  check(!/hatched/.test(painted.cls), `and it was hatched: "${painted.cls}"`);
  check(painted.inline !== '', 'it lost its own colour');
  check(/LAST WRITE 7200S AGO/.test(painted.eyebrow), `eyebrow reads: "${painted.eyebrow}"`);
}

test('a panel DARK ON SCHEDULE does not cry wolf (#82)');
{
  // Eight hours a night, every night, `confirmed` reads `unknown` by design. Before #82's
  // wire field this console appended "light says unknown" to the tally and painted the
  // Confirmed row yellow through all of it - about a panel that is working perfectly. A
  // console that cries wolf nightly teaches you to ignore it.
  const asleepPaint = await page.evaluate(() => {
    lastContactAt = Date.now();
    liveStatus = { state: 'on-air', confirmed: 'unknown', confirmedReason: 'asleep',
                   source: 'human:test', busy: true, intended: 'on', ageSeconds: 5, tableVersion: 1 };
    renderTally();
    renderStatus();
    const marks = [...document.getElementById('tally-marks').children].map((n) => n.textContent);
    const dds = [...document.querySelectorAll('#status-facts dd')];
    const confirmedDd = dds.find((d) => /unknown/.test(d.textContent));
    return { marks, cls: confirmedDd ? confirmedDd.className : '(row missing)',
             text: confirmedDd ? confirmedDd.textContent : '' };
  });

  check(!asleepPaint.marks.some((m) => /light says unknown/.test(m)),
        `the tally still says "light says unknown": ${JSON.stringify(asleepPaint.marks)}`);
  check(asleepPaint.marks.some((m) => /dark on schedule/.test(m)),
        `the tally does not explain why: ${JSON.stringify(asleepPaint.marks)}`);
  check(!/warn/.test(asleepPaint.cls), `the Confirmed row went yellow on a healthy night: "${asleepPaint.cls}"`);
  check(/dark on schedule/.test(asleepPaint.text), `the Confirmed row reads: "${asleepPaint.text}"`);
}

test('but a panel that is genuinely not answering STILL cries wolf (#82)');
{
  // The other half, and the one that matters more. Making the asleep case quiet must not
  // have made the broken case quiet with it - that would be a false OK, which is the same
  // family of failure as a false OFF.
  const brokenPaint = await page.evaluate(() => {
    lastContactAt = Date.now();
    liveStatus = { state: 'on-air', confirmed: 'unknown', confirmedReason: 'unreachable',
                   source: 'human:test', busy: true, intended: 'on', ageSeconds: 5, tableVersion: 1 };
    renderTally();
    renderStatus();
    const dds = [...document.querySelectorAll('#status-facts dd')];
    const confirmedDd = dds.find((d) => /unknown/.test(d.textContent));
    return { cls: confirmedDd ? confirmedDd.className : '(row missing)',
             text: confirmedDd ? confirmedDd.textContent : '',
             marks: [...document.getElementById('tally-marks').children].map((n) => n.textContent) };
  });

  check(/warn/.test(brokenPaint.cls), `a dead panel did NOT warn: "${brokenPaint.cls}"`);
  check(/not answering/.test(brokenPaint.text), `it does not say why: "${brokenPaint.text}"`);
  check(brokenPaint.marks.some((m) => /no answer from the panel/.test(m)),
        `the tally does not say it: ${JSON.stringify(brokenPaint.marks)}`);
}

test('a plain unknown with NO reason still warns - absence is not reassurance (#82)');
{
  // `confirmedReason` is absent whenever the server cannot name a reason, including in the
  // gap between a write and the supervisor's next tick. Treating absent as "fine" would put
  // the cry-wolf fix on the wrong side of the default.
  const bare = await page.evaluate(() => {
    lastContactAt = Date.now();
    liveStatus = { state: 'on-air', confirmed: 'unknown', source: 'human:test',
                   busy: true, intended: 'on', ageSeconds: 5, tableVersion: 1 };
    renderTally();
    renderStatus();
    const dds = [...document.querySelectorAll('#status-facts dd')];
    const confirmedDd = dds.find((d) => /unknown/.test(d.textContent));
    return confirmedDd ? confirmedDd.className : '(row missing)';
  });
  check(/warn/.test(bare), `an unexplained unknown did not warn: "${bare}"`);
}

test('a CALM state on a LOST connection does NOT wear its own colour');
{
  // Drive the server to a calm row, then age the evidence past the threshold from the
  // page's side, so the treatment is exercised on real data rather than a fixture.
  const states = await (await fetch(`${base}/config/states`, {
    headers: { authorization: 'Bearer onair' },
  }).then((r) => r.json()).catch(() => ({ states: [] })));
  const calm = (states.states || []).find((r) => !r.busy);
  check(!!calm, 'the seeded table has no calm row to test with');

  const painted = await page.evaluate((row) => {
    lastContactAt = Date.now() - 120000; // two minutes with no answer from the service
    liveStatus = { state: row.id, confirmed: row.id, source: 'human:test',
                   busy: false, intended: 'off', ageSeconds: 900, tableVersion: 1 };
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

test('a BUSY state on a LOST connection KEEPS its own colour - draining it weakens the signal');
{
  const states = await (await fetch(`${base}/config/states`, {
    headers: { authorization: 'Bearer onair' },
  }).then((r) => r.json()).catch(() => ({ states: [] })));
  const busy = (states.states || []).find((r) => r.busy && r.id !== 'unknown');
  check(!!busy, 'the seeded table has no busy row to test with');

  const painted = await page.evaluate((row) => {
    lastContactAt = Date.now() - 120000;
    liveStatus = { state: row.id, confirmed: row.id, source: 'human:test',
                   busy: true, intended: 'on', ageSeconds: 900, tableVersion: 1 };
    renderTally();
    const card = document.getElementById('tally');
    return { cls: card.className, inline: card.style.background };
  }, busy);

  check(/\blit\b/.test(painted.cls), `an unrefreshed busy state lost its colour: "${painted.cls}"`);
  check(/hatched/.test(painted.cls), 'an unrefreshed busy state is not marked at all');
  check(painted.inline !== '', 'the busy row was drained - false OFF is worse than false ON');
}

test('and a lost connection always says so, in words, next to the control that fixes it');
{
  const caution = await page.evaluate(() => {
    const c = document.getElementById('caution');
    return { hidden: c.hidden, text: c.textContent };
  });
  check(!caution.hidden, 'the caution band is hidden while contact is lost');
  check(/no answer from the service/i.test(caution.text), `caution reads: "${caution.text}"`);
  check(/last state it reported/i.test(caution.text),
        `the band must say the reading is not current: "${caution.text}"`);
}

test('THIRTY MINUTES with no answer: the console gives up on the state entirely');
{
  const painted = await page.evaluate(() => {
    lastContactAt = Date.now() - 1801000;
    renderTally();
    const card = document.getElementById('tally');
    return { cls: card.className, inline: card.style.background,
             eyebrow: document.getElementById('tally-eyebrow').textContent };
  });
  check(/withheld/.test(painted.cls), `not withheld at 30 minutes: "${painted.cls}"`);
  check(painted.inline === '', 'a colour was still painted after giving up');
  check(/NO DATA/.test(painted.eyebrow), `eyebrow reads: "${painted.eyebrow}"`);
}

test('and TWENTY-NINE minutes is still condition 2 - the thresholds are not chained');
{
  const states = await (await fetch(`${base}/config/states`, {
    headers: { authorization: 'Bearer onair' },
  }).then((r) => r.json()).catch(() => ({ states: [] })));
  const busy = (states.states || []).find((r) => r.busy && r.id !== 'unknown');
  const painted = await page.evaluate((row) => {
    lastContactAt = Date.now() - 1740000;
    liveStatus = { state: row.id, confirmed: row.id, source: 'human:test',
                   busy: true, intended: 'on', ageSeconds: 1800, tableVersion: 1 };
    renderTally();
    const card = document.getElementById('tally');
    return { cls: card.className, eyebrow: document.getElementById('tally-eyebrow').textContent };
  }, busy);
  check(!/NO DATA/.test(painted.eyebrow), `gave up 10 minutes early: "${painted.eyebrow}"`);
  check(/NOT REFRESHED/.test(painted.eyebrow), `eyebrow reads: "${painted.eyebrow}"`);
  check(/hatched/.test(painted.cls), 'held but unmarked');
}

test('a FAILED poll is what starts the clock - the console notices the service is gone');
{
  // The bug this closes: `if (r.status !== 200) return` threw the failure away, so a
  // service that stopped answering left the console fully confident forever.
  const marked = await page.evaluate(async () => {
    lastContactAt = Date.now() - 120000;
    const before = document.getElementById('caution').hidden;
    // Let the liveness timer, not a poll, do the work.
    await new Promise((r) => setTimeout(r, 1200));
    return { before, hidden: document.getElementById('caution').hidden };
  });
  check(marked.before === false, 'the band was not up before the tick');
  check(marked.hidden === false, 'the liveness timer did not keep the band up on its own clock');
}

// ---------------------------------------------------------------------------
// THE DEVICE LIST (#57, D-87).
//
// `light` is a read-only projection of whichever row is primary, so these tests drive
// `draft.devices` and read what the page draws from it. The two shapes that used to be one
// pair of fields - "which box does the service reach" and "which box does a link point at" -
// are now per row, and only the PRIMARY row can be overridden by the environment.

const seedDevices = (devices, env) =>
  page.evaluate(({ devices, env }) => {
    editing = {};
    draft.devices = devices;
    envInfo = env || { overrides: [], effective: {} };
    syncLight();
    renderDevices();
  }, { devices, env });

const aDevice = (over) => ({
  id: 'panel', label: 'Studio panel', host: '10.42.12.77', entity: 'PresenceKey',
  username: null, password: null, enabled: true, primary: true, order: 0, ...over,
});

const deviceLinks = () => page.$$eval('#device-fields .panel-link', (as) =>
  as.map((a) => ({ href: a.getAttribute('href'), target: a.target, rel: a.rel, text: a.textContent.trim() })));

const deviceRow = (n) => page.locator('#device-fields .row').nth(n);
const openEditor = async (n) => {
  await deviceRow(n).locator('.row-actions button:text-is("Edit")').click();
  await deviceRow(n).locator('.row-edit').waitFor();
};
const editorInput = (n, label) =>
  deviceRow(n).locator('.row-edit .field')
    .filter({ has: page.locator(`label:text-is("${label}")`) }).locator('input');

// The per-row fields live in that row's OPEN EDITOR, so an override assertion has to open
// one first - there is no longer a set of singular fields sitting on the section.
const editorFields = (n) => page.evaluate((idx) => {
  const out = {};
  document.querySelectorAll('#device-fields .row')[idx].querySelectorAll('.row-edit .field').forEach((f) => {
    const l = f.querySelector('label');
    const i = f.querySelector('input');
    const nag = f.querySelector('.nag');
    if (l && i) {
      out[l.textContent.trim()] =
        { value: i.value, placeholder: i.placeholder, readOnly: i.readOnly, type: i.type,
          checked: i.checked, nag: nag ? nag.textContent : '' };
    }
  });
  return out;
}, n);

const deviceState = () => page.evaluate(() => ({
  draft: draft.devices.map((d) => ({ id: d.id, label: d.label, host: d.host, primary: d.primary, enabled: d.enabled })),
  live: live.devices.map((d) => ({ id: d.id, label: d.label, host: d.host, primary: d.primary, enabled: d.enabled })),
  light: draft.light,
  staged: stagedDeviceIds(),
}));

test('the Device connection section links to the panel, in a new tab (#55)');
{
  await page.click('#view-advanced');
  await page.click('#rail button[data-sec="device"]');
  // The throwaway config has no device at all - correctly, a fresh install has not been
  // pointed at a panel yet - so give it one before asking what it links to.
  await seedDevices([aDevice()], { overrides: [], effective: { host: '10.42.12.77' } });
  const links = await deviceLinks();

  check(links.length === 3, `expected three panel links, got ${links.length}`);
  check(links.every((l) => l.target === '_blank'), 'a link does not open in a new tab');
  check(
    links.every((l) => /noopener/.test(l.rel) && /noreferrer/.test(l.rel)),
    `rel is wrong: ${links.map((l) => l.rel).join(' | ')}`,
  );
  check(links.some((l) => /\/onair$/.test(l.href || '')), `no status link: ${links.map((l) => l.href).join(', ')}`);
  check(links.some((l) => /\/onair\/config$/.test(l.href || '')), 'no settings link');
  check(links.some((l) => /\/onair\/config#night$/.test(l.href || '')), 'no night schedule link (#95)');
  check(links.every((l) => /^http:\/\//.test(l.href || '')), 'a link is not an http URL');
}

test('with NO device address configured, no link is emitted at all');
{
  await seedDevices([aDevice({ host: null })], { overrides: [], effective: {} });
  const forHostless = (await deviceLinks()).length;
  check(forHostless === 0, `a dead link was emitted for an unset host: ${forHostless}`);

  // And an EMPTY list is legal - it is what a fresh install has - so it must not be an
  // error, an empty row, or a link to nowhere.
  await seedDevices([], { overrides: [], effective: {} });
  const forEmpty = await page.evaluate(() => ({
    links: document.querySelectorAll('#device-fields .panel-link').length,
    rows: document.querySelectorAll('#device-fields .row').length,
  }));
  check(forEmpty.links === 0, `an empty list emitted ${forEmpty.links} links`);
  check(forEmpty.rows === 0, `an empty list drew ${forEmpty.rows} rows`);
}

test('a host that is not host-shaped never reaches an href');
{
  // The value is operator-set and lands in an href. The SCHEME is ours and only the
  // authority comes from config, but a string that is not host-shaped must not be linked
  // at all rather than trusted to be harmless once prefixed.
  await seedDevices([aDevice({ host: 'javascript:alert(1)' })],
    { overrides: [], effective: { host: 'javascript:alert(1)' } });
  const hrefs = (await deviceLinks()).map((l) => l.href);
  check(hrefs.length === 0, `a non-host was linked: ${hrefs.join(', ')}`);
}

test('an ENV-OVERRIDDEN field is read-only and names the variable winning (D-79)');
{
  await seedDevices([aDevice({ host: '10.0.0.1' })],
    { overrides: [{ key: 'light.host', variable: 'ONAIR_LIGHT_HOST' }], effective: { host: '10.0.0.99' } });
  await openEditor(0);
  const f = await editorFields(0);

  check(f.Address && f.Address.readOnly, 'an overridden field is still editable - saving it would change nothing');
  check(f.Address && f.Address.value === '10.0.0.99',
        `the field should show the EFFECTIVE value, got "${f.Address && f.Address.value}"`);
  check(/ONAIR_LIGHT_HOST/.test(f.Address ? f.Address.nag : ''), `the note should name the variable: "${f.Address && f.Address.nag}"`);
  check(/config\.env/.test(f.Address ? f.Address.nag : ''), `the note should name the file: "${f.Address && f.Address.nag}"`);
}

test('but a SECONDARY row is never overridden - the overlay names the primary only');
{
  await seedDevices(
    [aDevice({ host: '10.0.0.1' }), aDevice({ id: 'bench', label: 'Bench board', host: '10.0.0.5', primary: false, order: 1 })],
    { overrides: [{ key: 'light.host', variable: 'ONAIR_LIGHT_HOST' }], effective: { host: '10.0.0.99' } },
  );
  await openEditor(1);
  const f = await editorFields(1);
  check(f.Address && !f.Address.readOnly, 'a secondary address was locked by a variable that does not name it');
  check(f.Address && f.Address.value === '10.0.0.5',
        `a secondary should show its own address, got "${f.Address && f.Address.value}"`);
  check(f.Address && f.Address.nag === '', `a secondary claims an override: "${f.Address && f.Address.nag}"`);
}

test('and the link follows the OVERRIDE, not the document - a link gets clicked');
{
  await seedDevices(
    [aDevice({ host: '10.0.0.1' }), aDevice({ id: 'bench', label: 'Bench board', host: '10.0.0.5', primary: false, order: 1 })],
    { overrides: [{ key: 'light.host', variable: 'ONAIR_LIGHT_HOST' }], effective: { host: '10.0.0.99' } },
  );
  const hrefs = await page.$$eval('#device-fields .row', (rows) =>
    rows.map((r) => {
      const a = r.querySelector('.panel-link');
      return a ? a.getAttribute('href') : null;
    }));
  check(hrefs[0] === 'http://10.0.0.99/onair', `the primary link must name the box the service drives, got "${hrefs[0]}"`);
  check(hrefs[1] === 'http://10.0.0.5/onair', `a secondary link followed the primary's override: "${hrefs[1]}"`);
}

test('the card names the night schedule and points at the panel page that edits it (#95)');
{
  // The schedule is device-local (D-133): the console cannot show it or change it, and a
  // card with "Open the panel" and "Panel settings" gave no hint that it existed. The link
  // follows the same host rule as the other two - the primary's follows the override.
  await seedDevices([aDevice({ host: '10.0.0.1' })],
    { overrides: [{ key: 'light.host', variable: 'ONAIR_LIGHT_HOST' }], effective: { host: '10.0.0.99' } });
  const night = (await deviceLinks()).filter((l) => l.text === 'Night schedule');
  check(night.length === 1, `expected one Night schedule link, got ${night.length}`);
  check(night[0] && night[0].href === 'http://10.0.0.99/onair/config#night',
    `the night link must open the bar on the box the service drives, got "${night[0] && night[0].href}"`);
}

test('an overridden NON-credential shows its effective value; a credential does not');
{
  await seedDevices([aDevice()], {
    overrides: [
      { key: 'light.entity', variable: 'ONAIR_LIGHT_ENTITY' },
      { key: 'light.password', variable: 'ONAIR_LIGHT_PASS' },
    ],
    effective: { host: '10.0.0.99', entity: 'RealEntity' },
  });
  await openEditor(0);
  const seen = await editorFields(0);

  check(
    seen['Entity name'] && seen['Entity name'].value === 'RealEntity',
    `an overridden entity should show what is in force, got "${seen['Entity name'] && seen['Entity name'].value}"`,
  );
  check(
    seen['Device password'] && seen['Device password'].value === '',
    'a device credential must never be shown as an effective value',
  );
  check(
    seen['Device password'] && seen['Device password'].placeholder === 'not shown',
    'an empty credential box must say why it is empty, not read as unconfigured',
  );
  check(
    seen['Device password'] && seen['Device password'].type === 'password',
    'the device password is not masked',
  );
}

test('a device row SURVIVES a poll - the same node, still attached (#50, #54)');
{
  // The same defect, in the second list. A poll must never rebuild these nodes: typing goes
  // into an input that no longer exists, and a click lands on a button detached between
  // mousedown and click. Identity is the test - everything else about the page looks right.
  await seedDevices([aDevice()], { overrides: [], effective: {} });
  await page.evaluate(() => {
    const n = document.querySelector('#device-fields .row');
    n.dataset.marked = 'original';
    window.__dev = n;
  });
  await page.evaluate(() => refreshStatus());
  await page.evaluate(() => refreshStatus());
  await page.waitForTimeout(100);

  const verdict = await page.evaluate(() => ({
    sameObject: document.querySelector('#device-fields .row') === window.__dev,
    stillAttached: document.contains(window.__dev),
    markSurvived: window.__dev.dataset.marked === 'original',
  }));
  check(verdict.stillAttached, 'the device row was detached from the document by a poll');
  check(verdict.sameObject, 'the device row was replaced by a different node - this IS the bug');
  check(verdict.markSurvived, 'the node lost its identity across the poll');

  // And the listener came with it: Edit still opens the editor after two polls.
  await deviceRow(0).locator('.row-actions button:text-is("Edit")').click();
  await page.waitForTimeout(100);
  const opened = await deviceRow(0).locator('.row-edit').count();
  check(opened === 1, 'Edit did nothing after a poll - the handler was lost with the node');
  await deviceRow(0).locator('.row-edit button:text-is("Cancel")').click();
}

test('a SECOND device can be added and saved, and `light` follows the primary (#57)');
{
  await page.evaluate(() => { resetDraft(); editing = {}; renderAll(); });

  await page.click('#add-device');
  await deviceRow(0).locator('.row-edit').waitFor();
  await editorInput(0, 'Label').fill('Studio panel');
  await editorInput(0, 'Address').fill('10.42.12.77');
  // The first device seeds itself primary and enabled, or the list is unsaveable from the
  // moment it is created.
  const seeded = await editorFields(0);
  check(seeded.Primary && seeded.Primary.checked, 'the first device was not seeded primary');
  check(seeded.Enabled && seeded.Enabled.checked, 'the first device was not seeded enabled');
  await deviceRow(0).locator('.row-edit button:text-is("Save device")').click();

  await page.click('#add-device');
  await deviceRow(1).locator('.row-edit').waitFor();
  await editorInput(1, 'Label').fill('Bench board');
  await editorInput(1, 'Address').fill('10.42.12.78');
  await deviceRow(1).locator('.row-edit button:text-is("Save device")').click();

  const staged = await page.textContent('#staged-count');
  check(/2 staged/.test(staged), `two new rows should be two staged changes, got "${staged}"`);
  const where = await page.textContent('#staged-where');
  check(/2 in Device connection/.test(where), `the commit bar does not name where: "${where}"`);
  const badges = await page.$$eval('#device-fields .badge.staged', (bs) => bs.map((b) => b.textContent));
  check(badges.length === 2 && badges.every((b) => b === 'NEW'), `staged badges: [${badges.join(', ')}]`);

  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/admin/config') && r.request().method() === 'PUT'),
    page.click('#save-all'),
  ]);
  check(res.status() === 200, `the save was refused: ${res.status()} ${JSON.stringify(await res.json())}`);

  await page.waitForTimeout(200);
  const after = await deviceState();
  check(after.live.length === 2, `live carries ${after.live.length} devices`);
  check(
    JSON.stringify(after.live.map((d) => d.id)) === JSON.stringify(['studio-panel', 'bench-board']),
    `live ids: [${after.live.map((d) => d.id).join(', ')}]`,
  );
  check(after.live.filter((d) => d.primary).length === 1, 'live does not carry exactly one primary');
  check(after.light.host === '10.42.12.77', `light did not follow the primary: ${JSON.stringify(after.light)}`);
  const drawn = await page.$$eval('#device-fields .row .row-id span', (ss) => ss.map((s) => s.textContent.trim()));
  check(drawn.includes('bench-board'), `the saved row is not on screen: [${drawn.join(', ')}]`);
  check(after.staged.length === 0, `something stayed staged after a clean save: [${after.staged.join(', ')}]`);
}

test('making a SECONDARY primary clears the old one - exactly one is allowed');
{
  await openEditor(1);
  await editorInput(1, 'Primary').check();
  await deviceRow(1).locator('.row-edit button:text-is("Save device")').click();
  await page.waitForTimeout(100);

  const s = await deviceState();
  const primaries = s.draft.filter((d) => d.primary).map((d) => d.id);
  check(
    JSON.stringify(primaries) === JSON.stringify(['bench-board']),
    `expected bench-board alone to be primary, got [${primaries.join(', ')}]`,
  );
  // `light` is the projection, and the server refuses a payload where the two disagree.
  check(s.light.host === '10.42.12.78', `light did not follow the new primary: ${JSON.stringify(s.light)}`);
  check(s.staged.length === 2, `promoting one row should stage two, got [${s.staged.join(', ')}]`);

  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/admin/config') && r.request().method() === 'PUT'),
    page.click('#save-all'),
  ]);
  check(res.status() === 200, `the promotion was refused: ${res.status()} ${JSON.stringify(await res.json())}`);
}

test('a staged DELETION stays on screen, struck through, with an Undo');
{
  await page.waitForTimeout(200);
  // studio-panel is the secondary now, so deleting it promotes nobody - the row simply goes.
  await deviceRow(0).locator('.row-actions button:text-is("Delete")').click();
  await page.waitForSelector('#modal:not([hidden])');
  await page.click('#modal-ok');
  await page.waitForTimeout(100);

  const deleted = await page.$$eval('#device-fields .row.deleted', (rows) =>
    rows.map((r) => ({
      id: r.querySelector('.row-id span').textContent.trim(),
      staged: /\bstaged\b/.test(r.className),
      undo: [...r.querySelectorAll('.row-actions button')].map((b) => b.textContent.trim()),
    })));
  check(deleted.length === 1, `expected one struck-through row, got ${deleted.length}`);
  check(deleted[0] && deleted[0].id === 'studio-panel', `the wrong row was struck: ${JSON.stringify(deleted[0])}`);
  check(deleted[0] && deleted[0].staged, 'a staged deletion is not badged as staged');
  check(
    deleted[0] && JSON.stringify(deleted[0].undo) === JSON.stringify(['Undo delete']),
    `the deleted row's actions are [${deleted[0] ? deleted[0].undo.join(', ') : ''}]`,
  );
  const count = await page.textContent('#staged-count');
  check(/1 staged/.test(count), `a deletion should count once, got "${count}"`);

  await page.click('#device-fields .row.deleted .row-actions button');
  await page.waitForTimeout(100);
  const back = await deviceState();
  check(back.draft.some((d) => d.id === 'studio-panel'), 'Undo delete did not put the row back');
  check(back.staged.length === 0, `undoing left something staged: [${back.staged.join(', ')}]`);
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
