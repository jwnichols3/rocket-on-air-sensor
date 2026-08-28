import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { createApp } from '../src/app.js';
import { DOCS_HTML } from '../src/docs-page.js';
import type { LightDriver } from '../src/driver.js';
import { UNKNOWN_ID } from '../src/state.js';

const PAGE = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'docs-page.ts');
const GUIDE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'client-api-guide.md');

class StubDriver implements LightDriver {
  async set(id: string): Promise<string> {
    return id;
  }
  async read(): Promise<string> {
    return UNKNOWN_ID;
  }
}

async function boot(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'onair-docs-'));
  const app = await createApp({
    stateFile: join(dir, 'state.json'),
    configFile: join(dir, 'config.json'),
    port: 0,
    driver: new StubDriver(),
    log: () => {},
  });
  t.after(() => app.close().catch(() => {}));
  return `http://127.0.0.1:${app.port}`;
}

test('GET /docs is served, as HTML, with no credential and from any origin', async (t) => {
  const base = await boot(t);
  // The foreign Origin is what makes this a real test: it defeats the D-24 waiver, so a 200
  // here proves the route is genuinely public rather than merely reachable from loopback.
  const res = await fetch(`${base}/docs`, { headers: { origin: 'http://10.42.14.189:9099' } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await res.text(), /^<!doctype html>/);
});

test('/docs is GET only', async (t) => {
  const base = await boot(t);
  const res = await fetch(`${base}/docs`, { method: 'POST' });
  assert.equal(res.status, 405);
});

test('the generated module interpolates nothing, so it cannot leak a runtime value', () => {
  // Same property /display holds (D-25): byte-identical for every caller.
  //
  // The check is on the generated SOURCE, not on DOCS_HTML. The guide's JavaScript example
  // legitimately contains `${base}` as prose, so the runtime string contains `${` and always
  // will. What must never happen is an UNESCAPED `${` in the template literal, which would
  // turn page content into an expression the module evaluates at import time.
  const module = readFileSync(PAGE, 'utf8');
  const body = module.slice(module.indexOf('DOCS_HTML = `'));
  assert.equal(/(?<!\\)\$\{/.test(body), false, 'an unescaped ${ survived into the template literal');
  // Belt and braces: it is a constant, so whatever it holds it holds for everyone.
  assert.equal(typeof DOCS_HTML, 'string');
});

test('the generator left no markdown on the page', () => {
  // The rendering half of the deliverable, and the half that fails silently: a table that
  // did not become a table is still a 200. Fenced code is excluded because asterisks and
  // pipes are legitimate INSIDE a code block.
  const prose = DOCS_HTML.replace(/<pre>[\s\S]*?<\/pre>/g, '');
  assert.equal(/\*\*/.test(prose), false, 'unrendered bold markers');
  assert.equal(/^\s*\|/m.test(prose), false, 'unrendered table rows');
  assert.equal(/^#{1,4} /m.test(prose), false, 'unrendered headings');
  // The placeholder the inline renderer parks code spans in must never survive to the page.
  assert.equal(/<c\d+\/>/.test(DOCS_HTML), false, 'leaked code-span placeholder');
});

test('every endpoint the guide names still exists', async (t) => {
  // The drift this catches is the guide documenting a route that has been removed or
  // renamed - which a generated page cannot catch on its own, because it renders whatever
  // the markdown says. A 404 fails; a 405 passes, because it proves the path is real and
  // only the method was wrong.
  const base = await boot(t);
  const md = readFileSync(GUIDE, 'utf8');
  const paths = new Set<string>();
  for (const [, p] of md.matchAll(/`(?:GET|PUT|POST|DELETE)\s+(\/[^`\s]*)`/g)) paths.add(p);
  // `{id}` has no fixed value, and `/events/ws` answers an upgrade rather than a GET.
  const testable = [...paths].filter((p) => !p.includes('{') && !p.includes('*') && p !== '/events/ws');

  assert.ok(testable.length >= 10, `expected the guide to name real routes, found ${testable.length}`);
  for (const p of testable) {
    // ABORTED, never drained. `/events` and `/public/events` are SSE: their bodies never
    // end, so reading one hangs the run forever. The status line is all this test needs and
    // it arrives with the headers, long before the body would.
    const ac = new AbortController();
    const res = await fetch(`${base}${p}`, { signal: ac.signal });
    const { status } = res;
    ac.abort();
    assert.notEqual(status, 404, `the guide documents ${p}, which the server does not serve`);
  }

  // And the two that are excluded above are excluded for a reason, not because they are gone.
  assert.equal(paths.has('/state/{id}'), true);
  assert.equal(paths.has('/events/ws'), true);
});
