import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { createApp } from '../src/app.js';
import type { LightDriver } from '../src/driver.js';
import { UNKNOWN_ID } from '../src/state.js';

const BUNDLE = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'admin', 'index.html');
const html = (): string => readFileSync(BUNDLE, 'utf8');

class StubDriver implements LightDriver {
  async set(id: string): Promise<string> {
    return id;
  }
  async read(): Promise<string> {
    return UNKNOWN_ID;
  }
}

async function boot(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'onair-adminui-'));
  const app = await createApp({
    stateFile: join(dir, 'state.json'),
    configFile: join(dir, 'config.json'),
    port: 0,
    driver: new StubDriver(),
    log: () => {},
  });
  t.after(() => app.close().catch(() => {}));
  return { app, base: `http://127.0.0.1:${app.port}` };
}

test('the bundle is one self-contained file with no external resources', () => {
  const page = html();
  // Same rule as /display: the page has to render when the thing it would fetch assets
  // from is the thing that is broken.
  assert.equal(/<script[^>]+src=/.test(page), false, 'no external script');
  assert.equal(/<link[^>]+stylesheet/.test(page), false, 'no external stylesheet');
  assert.equal(/https?:\/\//.test(page.replace(/https?:\/\/127\.0\.0\.1/g, '')), false, 'no remote URLs');
  assert.equal(page.includes('/*STYLES*/'), false, 'the build substituted the CSS');
  assert.equal(page.includes('//SCRIPT'), false, 'the build substituted the JS');
});

test('the SHELL discloses nothing - it is byte-identical for every caller', async (t) => {
  const h = await boot(t);
  const anon = await fetch(`${h.base}/admin`, { headers: { origin: 'http://10.42.14.189:9099' } });
  assert.equal(anon.status, 200, 'served unauthenticated (D-35)');
  const a = await anon.text();
  const b = await (await fetch(`${h.base}/`)).text();
  assert.equal(a, b, '/ and /admin are the same bundle');
  // BYTE-IDENTITY IS THE TEST. Grepping the page for credential strings cannot work here:
  // the default passphrase is `onair`, a substring of the product's own name, and the
  // default admin password is `ESP32`, the name of the hardware. Both appear innocently.
  // What matters is not which strings are absent but that the bytes do not vary with who
  // asked - which is exactly D-25's argument, and is asserted above.
  //
  // What CAN be checked precisely is that no serialised config document is embedded.
  assert.equal(/"passphrase"\s*:/.test(a), false, 'no config document is baked into the shell');
  assert.equal(/"adminPassword"\s*:/.test(a), false);
  assert.equal(a.includes('${'), false, 'zero interpolation, so there is nowhere for one to appear');
});

test('every byte of data it renders comes from a gated route', () => {
  const page = html();
  // The console fetches these; each one is gated (or, for the landing tally, deliberately
  // public and deliberately thin).
  for (const route of ['/admin/config', '/admin/session', '/status', '/public/status']) {
    assert.equal(page.includes(route), true, `${route} should be fetched`);
  }
  // And it holds no state vocabulary of its own - the table it edits arrives at runtime.
  for (const row of ['on-air', 'interruptible', 'recording', 'available']) {
    assert.equal(page.includes("'" + row + "'"), false, `${row} must not be baked in`);
  }
});

test('NO RATIONALE PROSE in the shipped UI', () => {
  // Rocket on the prototype: "a lot of extra information, and some of it was not clearly
  // relevant to the changes". A hint survives only where it changes what someone types.
  // Comments are fine - they are not shipped to the eye - so strip them before looking.
  const page = html()
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  for (const tell of ['because', 'rationale', 'Note that', 'This exists', 'The reason']) {
    assert.equal(page.includes(tell), false, `explanatory prose ("${tell}") must not ship`);
  }
});

test('the three commit levels are all present, and distinct', () => {
  const page = html();
  // Cancel returns a row to its LAST STAGED value; Revert drops it to LIVE. Collapsing
  // them loses the ability to abandon a typo without discarding an older staged change.
  assert.match(page, /'Save row'/);
  assert.match(page, /'Cancel'/);
  assert.match(page, /'Revert'/);
  assert.match(page, /Save configuration/);
  assert.match(page, /Discard all/);
  // The distinction, asserted where it lives: Cancel goes back to the staged value, Revert
  // goes back to live.
  assert.match(page, /Back to the LAST STAGED value, not to live/);
});

test('the commit bar is sticky, so the staged count never scrolls away', () => {
  assert.match(html(), /\.bar\s*\{[^}]*position:\s*sticky/);
});

test('a staged draft blocks an accidental navigation', () => {
  assert.match(html(), /beforeunload/);
  assert.match(html(), /stagedCount\(\)\s*>\s*0/);
});

test('the draft is mirrored to sessionStorage so a reload does not lose it', () => {
  const page = html();
  assert.match(page, /sessionStorage\.setItem\(DRAFT_KEY/);
  assert.match(page, /sessionStorage\.getItem\(DRAFT_KEY/);
  // A draft diffed against an older document is dropped rather than silently merged.
  assert.match(page, /parsed\.version !== live\.version/);
});

test('a deletion counts ONCE - the prototype double-counted these', () => {
  const page = html();
  assert.match(page, /A deletion is one staged change, counted once/);
});

test('contrast is computed with the real WCAG formula, not an approximation', () => {
  const page = html();
  assert.match(page, /0\.2126/);
  assert.match(page, /0\.7152/);
  assert.match(page, /0\.0722/);
  assert.match(page, /4\.5/, 'AA for large text is 3:1; this holds rows to 4.5:1');
  assert.match(page, /fails AA/);
});

test('the id is shown locked, and a new row auto-slugs from its label', () => {
  const page = html();
  assert.match(page, /class="row-id"|'row-id'/);
  assert.match(page, /\\u\{1F512\}/, 'a visible lock, so nobody expects a rename to rebind Companion');
  assert.match(page, /function slugify/);
  assert.match(page, /replace\(\/\[\^a-z0-9\]\+\/g, '-'\)/);
});

test('the reserved row cannot be deleted from the UI either', () => {
  assert.match(html(), /row\.id !== 'unknown'/);
});

test('deleting a live or pinned row says what will actually happen', () => {
  const page = html();
  assert.match(page, /The live state becomes "unknown"/);
  assert.match(page, /The pin is released/);
  assert.match(page, /starts getting 400/);
  // ...and it still only stages.
  assert.match(page, /Stage the delete/);
});

test('the bundle is served with a clear 503 when it has not been built', async (t) => {
  // Not a 404: the route exists and the answer is "run the build", which is actionable.
  const h = await boot(t);
  const res = await fetch(`${h.base}/admin`);
  assert.equal(res.status, 200);
  await res.text();
});

test('/admin (the shell) is public, but /admin/config (the data) is not', async (t) => {
  const h = await boot(t);
  const remote = { origin: 'http://10.42.14.189:9099' };
  assert.equal((await fetch(`${h.base}/admin`, { headers: remote })).status, 200);
  assert.equal((await fetch(`${h.base}/admin/config`, { headers: remote })).status, 401);
});

test('the poll rebuilds NEITHER the chips NOR the rows (#54)', () => {
  const page = html();
  // Found twice, by driving the page, and silent both times. renderRows() replaced every
  // row node: typing went into an input that no longer existed a moment later, and a click
  // on Edit landed on a button detached between mousedown and click, so the handler never
  // ran. The guard written for that covered the rows alone, and the state buttons - the
  // MOST-CLICKED controls on the page - kept being rebuilt every five seconds. No error, no
  // console entry, the page just did not respond.
  //
  // Structural only. What actually settles this is admin-ui/test/browser.mjs, which holds a
  // reference to a live chip across two polls and asserts it is the same object still in
  // the document - the one thing no amount of reading the source can establish.
  assert.match(page, /NEITHER THE CHIPS NOR THE ROWS ARE REBUILT ON A POLL/);

  // The rows: rebuilt only when the LIVE badge moves, and never while a row is being edited.
  assert.match(page, /var liveChanged = lastRenderedState !== liveStatus\.state/);
  assert.match(page, /if \(liveChanged && Object\.keys\(editing\)\.length === 0\) renderRows\(\)/);

  // The chips: built once per table version, marked on every tick.
  assert.match(page, /function buildChips\(\)/);
  assert.match(page, /function markChips\(\)/);
  assert.match(page, /if \(builtForVersion !== \(live \? live\.version : null\)\) buildChips\(\)/);

  // markChips is the poll path. If it ever creates or appends a node the split is undone.
  const mark = /function markChips\(\)\s*\{[\s\S]*?\n\}/.exec(page);
  assert.ok(mark, 'markChips should be findable');
  assert.equal(/clear\(|appendChild|createElement/.test(mark[0]), false,
    'the poll path must never touch a node');

  // And the chips read LIVE, never the draft: a staged rename must not appear on the
  // buttons that command the server. One of the design prototypes got this wrong.
  const build = /function buildChips\(\)\s*\{[\s\S]*?\n\}/.exec(page);
  assert.ok(build, 'buildChips should be findable');
  assert.equal(/draft\.states/.test(build[0]), false, 'the chips must be built from live');
});

test('the console does not name its state global `status`', () => {
  const page = html();
  // `var status` at top level in a classic script binds window.status, a legacy STRING
  // property - so `status = someObject` silently stores "[object Object]", which is truthy
  // and has no fields. It rendered as a blank page with one exception and nothing else.
  // Matched as a DECLARATION, not as the words - the comment explaining the trap says
  // "var status" too, and a check that cannot survive its own explanation is a bad check.
  assert.equal(/\bvar\s+status\s*[=;]/.test(page), false);
  assert.match(page, /var liveStatus = null/);
});
