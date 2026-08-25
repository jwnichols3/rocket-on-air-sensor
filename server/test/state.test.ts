import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  coerceSource,
  defaultState,
  ID_PATTERN,
  parseSource,
  SEED_ROWS,
  SEED_SHORTCUTS,
  StateStore,
  StateTable,
  UNKNOWN_ID,
  type Source,
  type StateRow,
} from '../src/state.js';

const HUMAN: Source = { kind: 'human', label: 'test', raw: 'human:test' };
const AUTO: Source = { kind: 'auto', label: 'test', raw: 'auto:test' };

// ---------------------------------------------------------------- the table

test('the seed table is the one in the contract, and every id is legal', () => {
  assert.deepEqual(
    SEED_ROWS.map((r) => r.id),
    ['available', 'on-air', 'interruptible', 'recording', 'unknown'],
  );
  for (const row of SEED_ROWS) {
    assert.ok(ID_PATTERN.test(row.id), `${row.id} must match the id pattern`);
    assert.ok(row.label.length >= 1 && row.label.length <= 64);
    assert.match(row.color, /^#[0-9a-f]{6}$/);
    assert.match(row.bgcolor, /^#[0-9a-f]{6}$/);
  }
});

test('there is no dnd and no ladder', () => {
  const table = new StateTable();
  assert.equal(table.has('dnd'), false);
  // Nothing in the row shape ranks anything. `order` is the only ordinal and it is a sort
  // hint - the test that matters is that it is never used as an address.
  assert.equal(Object.keys(SEED_ROWS[0]!).includes('rank'), false);
});

test('ids() sorts by order then id, and that order is NOT an address', () => {
  const table = new StateTable();
  assert.deepEqual(table.ids(), ['available', 'on-air', 'interruptible', 'recording', 'unknown']);
  // Reordering is cosmetic: the same ids resolve to the same rows (D-34).
  const reordered = new StateTable(SEED_ROWS.map((r) => ({ ...r, order: 99 - r.order })));
  assert.deepEqual([...reordered.ids()].sort(), [...table.ids()].sort());
  assert.equal(reordered.row('on-air')!.busy, table.row('on-air')!.busy);
});

test('unknown always exists and its busy is forced true, even if a table says otherwise', () => {
  const lying: StateRow[] = [{ ...SEED_ROWS[SEED_ROWS.length - 1]!, busy: false }];
  const table = new StateTable(lying);
  assert.equal(table.has(UNKNOWN_ID), true);
  assert.equal(table.busy(UNKNOWN_ID), true, 'the reserved row can never be calm');
});

test('unknown is reinstated even when a table omits it entirely', () => {
  const table = new StateTable([{ ...SEED_ROWS[0]! }]);
  assert.equal(table.has(UNKNOWN_ID), true, 'it cannot be deleted');
  assert.equal(table.busy(UNKNOWN_ID), true);
});

test('busy() defaults to TRUE for an id that is not in the table', () => {
  const table = new StateTable();
  // The default is the whole safety model in one line: an id nobody recognises must never
  // read as calm.
  assert.equal(table.busy('who-knows'), true);
});

test('the seed shortcuts name rows that exist', () => {
  const table = new StateTable();
  assert.equal(table.has(SEED_SHORTCUTS.on!), true);
  assert.equal(table.has(SEED_SHORTCUTS.off!), true);
  assert.equal(table.busy(SEED_SHORTCUTS.on!), true, '/on must reach a busy row');
  assert.equal(table.busy(SEED_SHORTCUTS.off!), false);
});

// --------------------------------------------------------------- source (§4)

test('parseSource is STRICT: the prefix is required', () => {
  assert.deepEqual(parseSource('auto:vcrec'), { kind: 'auto', label: 'vcrec', raw: 'auto:vcrec' });
  assert.deepEqual(parseSource('human:menubar'), { kind: 'human', label: 'menubar', raw: 'human:menubar' });
  assert.equal(parseSource('vcrec'), null, 'an unprefixed source on PUT /state is a 400');
  assert.equal(parseSource('detector'), null);
  assert.equal(parseSource('robot:vcrec'), null, 'only auto and human are kinds');
  assert.equal(parseSource(undefined), null);
  assert.equal(parseSource(''), null);
  assert.equal(parseSource('auto:'), null, 'the label is 1..32 chars');
  assert.equal(parseSource(`auto:${'x'.repeat(33)}`), null);
});

test('an automated writer that forgets the prefix does NOT quietly get human authority', () => {
  // This is the whole reason the strict/lenient split exists (D-41). Silently promoting
  // `vcrec` to human: would let a detector break the owner's holds.
  assert.equal(parseSource('vcrec'), null);
});

test('coerceSource is lenient, because a human is typing it into curl', () => {
  assert.equal(coerceSource(undefined).raw, 'human:anonymous');
  assert.equal(coerceSource(null).raw, 'human:anonymous');
  assert.equal(coerceSource('   ').raw, 'human:anonymous');
  assert.equal(coerceSource('menubar').raw, 'human:menubar');
  assert.equal(coerceSource('human:ui').raw, 'human:ui');
  assert.equal(coerceSource('auto:vcrec').raw, 'auto:vcrec');
});

test('the one legacy value: bare "detector" reads as auto:detector, not human:detector', () => {
  const s = coerceSource('detector');
  assert.equal(s.kind, 'auto');
  assert.equal(s.raw, 'auto:detector');
});

// ---------------------------------------------------------------- the store

test('defaultState is unknown, never available', () => {
  const s = defaultState();
  assert.equal(s.state, UNKNOWN_ID);
  assert.equal(s.confirmed, UNKNOWN_ID);
  // Every degenerate path lands somewhere conspicuous. A first boot that rendered calm
  // would be asserting something it has no evidence for.
  assert.equal(new StateTable().busy(s.state), true);
});

test('status() derives busy and intended from the row, never from the payload', () => {
  const store = new StateStore(defaultState(), new StateTable());
  store.write('on-air', AUTO);
  let st = store.status();
  assert.equal(st.state, 'on-air');
  assert.equal(st.busy, true);
  assert.equal(st.intended, 'on');
  store.write('available', HUMAN);
  st = store.status();
  assert.equal(st.busy, false);
  assert.equal(st.intended, 'off');
  assert.equal(st.tableVersion, 1);
});

test('intended follows the ROW, so a row whose busy flips flips intended with it', () => {
  const store = new StateStore(defaultState(), new StateTable());
  store.write('interruptible', HUMAN);
  assert.equal(store.status().intended, 'off');
  store.setTable(new StateTable(SEED_ROWS.map((r) => (r.id === 'interruptible' ? { ...r, busy: true } : r)), 2));
  assert.equal(store.status().intended, 'on', 'intended is derived, never stored');
  assert.equal(store.status().tableVersion, 2);
});

test('NO presentation in the state payload (D-42)', () => {
  const store = new StateStore(defaultState(), new StateTable());
  store.write('on-air', AUTO);
  const st = store.status() as unknown as Record<string, unknown>;
  for (const field of ['label', 'color', 'bgcolor', 'description', 'order']) {
    assert.equal(field in st, false, `${field} must not travel with the state`);
  }
  // What DOES travel is semantics.
  for (const field of ['state', 'busy', 'intended', 'confirmed']) {
    assert.equal(field in st, true, `${field} is semantics and must travel`);
  }
});

test('a write clears confirmed: a new assertion is not evidence about the device', () => {
  const store = new StateStore(defaultState(), new StateTable());
  store.setConfirmed('available');
  store.write('on-air', AUTO);
  assert.equal(store.get().confirmed, UNKNOWN_ID);
});

test('stale is ageSeconds > 90, and is presentation only', () => {
  const store = new StateStore(defaultState(), new StateTable());
  const t0 = new Date('2026-08-24T12:00:00Z');
  store.write('available', HUMAN, t0);
  assert.equal(store.stale(new Date(t0.getTime() + 90_000)), false);
  assert.equal(store.stale(new Date(t0.getTime() + 91_000)), true);
  // Staleness never changes the state itself. No TTL, no decay (D-6, §3).
  assert.equal(store.get().state, 'available');
});

// ------------------------------------------------------- lifecycle (D-34, §6)

test('the live row being deleted resolves to unknown and NAMES the dead id', () => {
  const store = new StateStore(defaultState(), new StateTable());
  store.write('recording', HUMAN);
  store.setTable(new StateTable(SEED_ROWS.filter((r) => r.id !== 'recording'), 2));
  const st = store.status();
  assert.equal(st.state, UNKNOWN_ID);
  assert.equal(st.stateResolvedFrom, 'recording');
  assert.equal(st.busy, true, 'the fallback is conspicuous, never calm');
});

test('stateResolvedFrom is absent once a real state is written again', () => {
  const store = new StateStore(defaultState(), new StateTable());
  store.write('recording', HUMAN);
  store.setTable(new StateTable(SEED_ROWS.filter((r) => r.id !== 'recording'), 2));
  assert.equal(store.status().stateResolvedFrom, 'recording');
  store.write('on-air', HUMAN);
  assert.equal('stateResolvedFrom' in store.status(), false);
});

test('deleting the pinned row releases the pin in the same operation', () => {
  const store = new StateStore(defaultState(), new StateTable());
  store.write('interruptible', HUMAN, new Date(), true);
  assert.equal(store.get().hold, 'interruptible');
  store.setTable(new StateTable(SEED_ROWS.filter((r) => r.id !== 'interruptible'), 2));
  assert.equal(store.get().hold, null);
});

test('a confirmed id that leaves the table decays to unknown, never to a stale row', () => {
  const store = new StateStore(defaultState(), new StateTable());
  store.write('recording', HUMAN);
  store.setConfirmed('recording');
  store.setTable(new StateTable(SEED_ROWS.filter((r) => r.id !== 'recording'), 2));
  assert.equal(store.get().confirmed, UNKNOWN_ID);
});

// ------------------------------------------------------------------- holds

test('hold:true pins at this write, hold:false releases, omitted leaves it alone', () => {
  const store = new StateStore(defaultState(), new StateTable());
  store.write('interruptible', HUMAN, new Date(), true);
  assert.equal(store.get().hold, 'interruptible');
  store.write('interruptible', AUTO);
  assert.equal(store.get().hold, 'interruptible', 'an auto write does not disturb the pin');
  store.write('interruptible', HUMAN, new Date(), false);
  assert.equal(store.get().hold, null);
});

test('pinning to available is legal - it cannot force calm against a live camera', () => {
  const store = new StateStore(defaultState(), new StateTable());
  store.write('available', HUMAN, new Date(), true);
  assert.equal(store.get().hold, 'available');
});

test('a human write naming a different state releases the pin', () => {
  const store = new StateStore(defaultState(), new StateTable());
  store.write('interruptible', HUMAN, new Date(), true);
  store.write('on-air', HUMAN);
  assert.equal(store.get().hold, null, 'the store never reports a hold that contradicts state');
});

// ---------------------------------------------------------------- persistence

test('persisted() carries intended and tableVersion, and never a live confirmed', () => {
  const store = new StateStore(defaultState(), new StateTable());
  store.write('on-air', AUTO);
  store.setConfirmed('on-air');
  const p = store.persisted();
  assert.equal(p.state, 'on-air');
  assert.equal(p.intended, 'on');
  assert.equal(p.tableVersion, 1);
  assert.equal(p.confirmed, UNKNOWN_ID, 'a file records intent, never evidence about the device');
});
