import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NoopDriver } from '../src/driver.js';

test('noop driver logs the transition and reports unknown', async () => {
  const lines: string[] = [];
  const driver = new NoopDriver((line) => lines.push(line));
  assert.equal(await driver.set(true), 'unknown');
  assert.equal(await driver.set(false), 'unknown');
  assert.deepEqual(lines, ['[noop-driver] light -> ON', '[noop-driver] light -> OFF']);
});
