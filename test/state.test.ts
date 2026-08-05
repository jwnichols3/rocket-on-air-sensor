import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultState, isOnAirState, StateStore } from '../src/state.js';

test('defaultState is off/unknown from boot', () => {
  const s = defaultState(new Date('2026-08-05T00:00:00Z'));
  assert.deepEqual(s, {
    intended: 'off',
    confirmed: 'unknown',
    source: 'boot',
    updatedAt: '2026-08-05T00:00:00.000Z',
    message: null,
  });
});

test('write sets intended/source/updatedAt and resets confirmed to unknown', () => {
  const store = new StateStore(defaultState(new Date('2026-08-05T00:00:00Z')));
  store.setConfirmed('on');
  const now = new Date('2026-08-05T01:00:00Z');
  const state = store.write(true, 'detector', now);
  assert.equal(state.intended, 'on');
  assert.equal(state.confirmed, 'unknown');
  assert.equal(state.source, 'detector');
  assert.equal(state.updatedAt, now.toISOString());
});

test('setConfirmed updates only confirmed', () => {
  const store = new StateStore(defaultState());
  store.write(true, 'manual');
  const state = store.setConfirmed('on');
  assert.equal(state.confirmed, 'on');
  assert.equal(state.intended, 'on');
});

test('get returns a copy, not a live reference', () => {
  const store = new StateStore(defaultState());
  const a = store.get();
  a.intended = 'on';
  assert.equal(store.get().intended, 'off');
});

test('ageSeconds measures whole seconds since last write, never negative', () => {
  const store = new StateStore(defaultState(new Date('2026-08-05T00:00:00Z')));
  store.write(false, 'manual', new Date('2026-08-05T00:00:00Z'));
  assert.equal(store.ageSeconds(new Date('2026-08-05T00:00:42.400Z')), 42);
  assert.equal(store.ageSeconds(new Date('2026-08-04T23:59:00Z')), 0);
});

test('isOnAirState accepts valid state and rejects junk', () => {
  assert.equal(isOnAirState(defaultState()), true);
  assert.equal(isOnAirState(null), false);
  assert.equal(isOnAirState({ intended: 'maybe', confirmed: 'unknown', source: 'x', updatedAt: 'now' }), false);
  assert.equal(isOnAirState({ intended: 'on', confirmed: 'off', source: 7, updatedAt: 'now' }), false);
});

test('setMessage and clearMessage change only message', () => {
  const store = new StateStore(defaultState(new Date('2026-08-05T00:00:00Z')));
  const withMsg = store.setMessage('BE QUIET');
  assert.equal(withMsg.message, 'BE QUIET');
  assert.equal(withMsg.updatedAt, '2026-08-05T00:00:00.000Z');
  const cleared = store.clearMessage();
  assert.equal(cleared.message, null);
});

test('on-air write preserves an existing message', () => {
  const store = new StateStore(defaultState());
  store.setMessage('BE QUIET');
  const state = store.write(true, 'detector');
  assert.equal(state.message, 'BE QUIET');
  assert.equal(state.intended, 'on');
});
