import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  defaultState,
  higher,
  isLevel,
  isOnAirState,
  levelToOnOff,
  onAirToLevel,
  RANK,
  StateStore,
} from '../src/state.js';

test('defaultState boots at dnd, never available', () => {
  const s = defaultState(new Date('2026-08-05T00:00:00Z'));
  assert.deepEqual(s, {
    level: 'dnd',
    confirmed: 'unknown',
    source: 'boot',
    updatedAt: '2026-08-05T00:00:00.000Z',
    message: null,
    hold: null,
  });
});

test('levelToOnOff derives the legacy boolean: only available is off', () => {
  assert.equal(levelToOnOff('available'), 'off');
  assert.equal(levelToOnOff('interruptible'), 'on');
  assert.equal(levelToOnOff('dnd'), 'on');
});

test('onAirToLevel rounds a legacy true UP to dnd', () => {
  assert.equal(onAirToLevel(true), 'dnd');
  assert.equal(onAirToLevel(false), 'available');
});

test('higher returns the higher rung', () => {
  assert.equal(higher('available', 'dnd'), 'dnd');
  assert.equal(higher('dnd', 'available'), 'dnd');
  assert.equal(higher('interruptible', 'available'), 'interruptible');
  assert.equal(higher('interruptible', 'interruptible'), 'interruptible');
  assert.equal(RANK.available < RANK.interruptible && RANK.interruptible < RANK.dnd, true);
});

test('isLevel accepts the three rungs and nothing else', () => {
  assert.equal(isLevel('available'), true);
  assert.equal(isLevel('interruptible'), true);
  assert.equal(isLevel('dnd'), true);
  assert.equal(isLevel('on'), false);
  assert.equal(isLevel(undefined), false);
});

test('write sets level/source/updatedAt and resets confirmed to unknown', () => {
  const store = new StateStore(defaultState(new Date('2026-08-05T00:00:00Z')));
  store.setConfirmed('dnd');
  const now = new Date('2026-08-05T01:00:00Z');
  const state = store.write('interruptible', 'webui', now);
  assert.equal(state.level, 'interruptible');
  assert.equal(state.confirmed, 'unknown');
  assert.equal(state.source, 'webui');
  assert.equal(state.updatedAt, now.toISOString());
});

test('setConfirmed updates only confirmed, and can hold a Level', () => {
  const store = new StateStore(defaultState());
  store.write('interruptible', 'manual');
  const state = store.setConfirmed('interruptible');
  assert.equal(state.confirmed, 'interruptible');
  assert.equal(state.level, 'interruptible');
});

test('get returns a copy, not a live reference', () => {
  const store = new StateStore(defaultState());
  const a = store.get();
  a.level = 'available';
  assert.equal(store.get().level, 'dnd');
});

test('ageSeconds measures whole seconds since last write, never negative', () => {
  const store = new StateStore(defaultState(new Date('2026-08-05T00:00:00Z')));
  store.write('available', 'manual', new Date('2026-08-05T00:00:00Z'));
  assert.equal(store.ageSeconds(new Date('2026-08-05T00:00:42.400Z')), 42);
  assert.equal(store.ageSeconds(new Date('2026-08-04T23:59:00Z')), 0);
});

test('isOnAirState accepts a new file, a legacy file, and rejects junk', () => {
  assert.equal(isOnAirState(defaultState()), true);
  // legacy: intended, no level
  assert.equal(
    isOnAirState({ intended: 'on', confirmed: 'unknown', source: 'x', updatedAt: '2026-08-05T00:00:00Z' }),
    true,
  );
  assert.equal(isOnAirState(null), false);
  assert.equal(isOnAirState({ level: 'maybe', confirmed: 'unknown', source: 'x', updatedAt: '2026-08-05T00:00:00Z' }), false);
  assert.equal(isOnAirState({ level: 'dnd', confirmed: 'dnd', source: 7, updatedAt: '2026-08-05T00:00:00Z' }), false);
  assert.equal(isOnAirState({ level: 'dnd', confirmed: 'dnd', source: 'x', updatedAt: 'not-a-date' }), false);
  assert.equal(isOnAirState({ level: 'dnd', confirmed: 'dnd', source: 'x', updatedAt: '2026-08-05T00:00:00Z', hold: 'available' }), false);
});

test('setMessage and clearMessage change only message', () => {
  const store = new StateStore(defaultState(new Date('2026-08-05T00:00:00Z')));
  const withMsg = store.setMessage('BE QUIET');
  assert.equal(withMsg.message, 'BE QUIET');
  assert.equal(withMsg.updatedAt, '2026-08-05T00:00:00.000Z');
  const cleared = store.clearMessage();
  assert.equal(cleared.message, null);
});

test('a write preserves an existing message', () => {
  const store = new StateStore(defaultState());
  store.setMessage('BE QUIET');
  const state = store.write('dnd', 'detector');
  assert.equal(state.message, 'BE QUIET');
  assert.equal(state.level, 'dnd');
});

// --- the manual hold: a floor on level (handoff brief 2026-08-23, D-19) ---

test('hold: a detector write below the floor is clamped up to it', () => {
  const store = new StateStore(defaultState());
  store.write('interruptible', 'manual', new Date(), true);
  const s = store.write('available', 'detector');
  assert.equal(s.level, 'interruptible');
  assert.equal(s.hold, 'interruptible');
});

test('hold: the floor never blocks escalation', () => {
  const store = new StateStore(defaultState());
  store.write('interruptible', 'manual', new Date(), true);
  const s = store.write('dnd', 'detector');
  assert.equal(s.level, 'dnd');
  assert.equal(s.hold, 'interruptible', 'the floor survives the escalation');
});

test('hold: after an escalation ends, the detector falls back to the floor, not to available', () => {
  const store = new StateStore(defaultState());
  store.write('interruptible', 'manual', new Date(), true);
  store.write('dnd', 'detector');
  const s = store.write('available', 'detector');
  assert.equal(s.level, 'interruptible');
});

test('hold: a manual write clears the floor and may go to available', () => {
  const store = new StateStore(defaultState());
  store.write('interruptible', 'manual', new Date(), true);
  const s = store.write('available', 'manual', new Date(), false);
  assert.equal(s.level, 'available');
  assert.equal(s.hold, null);
});

test('hold: a write with no source can clear the floor', () => {
  const store = new StateStore(defaultState());
  store.write('dnd', 'manual', new Date(), true);
  const s = store.write('available', '', new Date(), false);
  assert.equal(s.hold, null);
  assert.equal(s.level, 'available');
});

test('hold: omitting hold leaves the floor untouched', () => {
  const store = new StateStore(defaultState());
  store.write('interruptible', 'manual', new Date(), true);
  const s = store.write('dnd', 'webui');
  assert.equal(s.hold, 'interruptible');
});

test('hold: a detector write never modifies the floor', () => {
  const store = new StateStore(defaultState());
  store.write('interruptible', 'manual', new Date(), true);
  const s = store.write('dnd', 'detector', new Date(), false);
  assert.equal(s.hold, 'interruptible', 'a detector cannot release a manual hold');
});

test('hold: the floor is not evidence and does not decay with age', () => {
  const store = new StateStore(defaultState());
  store.write('interruptible', 'manual', new Date('2026-08-05T00:00:00Z'), true);
  store.write('available', 'detector', new Date('2026-08-05T12:00:00Z'));
  assert.equal(store.get().hold, 'interruptible');
  assert.equal(store.get().level, 'interruptible');
});

test('hold: a manual write BELOW the floor releases the floor', () => {
  const store = new StateStore(defaultState());
  store.write('dnd', 'manual', new Date(), true);
  const s = store.write('available', 'webui');
  assert.equal(s.level, 'available');
  assert.equal(s.hold, null, 'a human asking for green must not leave a floor that undoes it');
  assert.equal(store.write('available', 'detector').level, 'available');
});
