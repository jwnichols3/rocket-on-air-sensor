// Browser tests for the admin console (#54).
//
// WHY A BROWSER. server/test/admin-ui.test.ts asserts on the built bundle as TEXT. That
// catches "the source says the right thing" and cannot catch the class of defect this file
// exists for: whether a node the user is about to click still exists when the click lands.
//
// Both instances of that defect in this console were found by driving the page by hand and
// neither left a trace - no error, no console entry, the page simply did not respond. A
// grep test cannot see them, because the code that causes them looks completely ordinary.
// Only a browser that holds a reference across a poll can settle it.
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

await page.goto(base);
await page.waitForSelector('#console:not([hidden])', { timeout: 10000 });
await page.waitForFunction(() => document.querySelectorAll('#status-controls button').length > 0);

// ---------------------------------------------------------------------------

test('the console reaches the logged-in state over the loopback waiver (D-24)');
check(await page.isVisible('#console'), 'the console never appeared');
check(pageErrors.length === 0, `page errors: ${pageErrors.join(' | ')}`);

test('a state button SURVIVES a poll - the same node, still attached (#54)');
{
  // Tag the live node, force the poll path the way the 5s timer does, then ask whether the
  // very same element object is still in the document. Identity is the test: a rebuilt
  // button would be a different object holding a different listener, and everything else
  // about the page would look correct.
  await page.evaluate(() => {
    const b = document.querySelector('#status-controls button');
    b.dataset.marked = 'original';
    window.__node = b;
  });

  const before = await page.evaluate(() => document.querySelectorAll('#status-controls button').length);
  await page.evaluate(() => refreshStatus());
  await page.evaluate(() => refreshStatus());
  await page.waitForTimeout(100);

  const verdict = await page.evaluate(() => ({
    sameObject: document.querySelector('#status-controls button') === window.__node,
    stillAttached: document.contains(window.__node),
    markSurvived: window.__node.dataset.marked === 'original',
    count: document.querySelectorAll('#status-controls button').length,
  }));

  check(verdict.stillAttached, 'the button was detached from the document by a poll');
  check(verdict.sameObject, 'the button was replaced by a different node - this IS the bug');
  check(verdict.markSurvived, 'the node lost its identity across the poll');
  check(verdict.count === before, `button count moved: ${before} -> ${verdict.count}`);
}

test('and the click still works after polls have run - the listener came with it');
{
  const target = await page.evaluate(() => {
    // Pick a state that is NOT the current one, so a successful write is visible.
    const wanted = [...document.querySelectorAll('#status-controls button')]
      .find((b) => !/pin/i.test(b.textContent));
    return wanted ? wanted.textContent : null;
  });
  check(target !== null, 'no state button to click');

  const stateBefore = await (await fetch(`${base}/status`)).json();
  await page.evaluate(() => refreshStatus());
  await page.click(`#status-controls button:has-text("${target}")`);
  await page.waitForTimeout(400);
  const stateAfter = await (await fetch(`${base}/status`)).json();

  check(
    stateAfter.updatedAt !== stateBefore.updatedAt || stateAfter.state !== stateBefore.state,
    'the click reached the server not at all - handler lost with the node',
  );
}

test('the pin reads its state at CLICK time, not at build time');
{
  // The old handler captured `pinned` in the closure. That was harmless only because the
  // node was rebuilt every five seconds; with a build-once button it would pin, then refuse
  // to unpin, forever.
  const label = () => page.evaluate(() =>
    [...document.querySelectorAll('#status-controls button')].at(-1).textContent);

  const first = await label();
  await page.click('#status-controls button:last-child');
  await page.waitForTimeout(400);
  const second = await label();
  check(first !== second, `the pin label did not change: "${first}" -> "${second}"`);

  await page.click('#status-controls button:last-child');
  await page.waitForTimeout(400);
  const third = await label();
  check(third === first, `the pin did not toggle back: "${second}" -> "${third}" (wanted "${first}")`);
}

test('an open row editor is not destroyed by a poll');
{
  await page.click('.rail a[data-sec="states"]').catch(() => {});
  await page.click('.row .row-actions button:has-text("Edit")');
  await page.waitForSelector('.row-edit input');
  await page.fill('.row-edit input', 'TYPED-WHILE-POLLING');
  await page.evaluate(() => refreshStatus());
  await page.evaluate(() => refreshStatus());
  await page.waitForTimeout(100);
  const survived = await page.inputValue('.row-edit input');
  check(survived === 'TYPED-WHILE-POLLING', `the editor lost its input: got "${survived}"`);
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
