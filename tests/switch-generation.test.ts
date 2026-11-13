import assert from 'node:assert/strict';
import test from 'node:test';
import { SwitchGeneration } from '../src/core/switch-generation';

test('only the newest generation commits; an older resolution is discarded', () => {
  const generation = new SwitchGeneration();
  const first = generation.begin();
  const second = generation.begin();
  const committed: string[] = [];
  const discarded: string[] = [];
  // Simulate the newer load resolving first, then the stale one.
  assert.equal(
    generation.settle(
      second,
      'newer-mask',
      (value) => committed.push(value),
      (value) => discarded.push(value),
    ),
    true,
  );
  assert.equal(
    generation.settle(
      first,
      'older-mask',
      (value) => committed.push(value),
      (value) => discarded.push(value),
    ),
    false,
  );
  assert.deepEqual(committed, ['newer-mask']);
  assert.deepEqual(discarded, ['older-mask']);
});

test('invalidate cancels an in-flight generation without a new load', () => {
  const generation = new SwitchGeneration();
  const token = generation.begin();
  generation.invalidate();
  assert.equal(generation.isCurrent(token), false);
  assert.equal(
    generation.settle(
      token,
      'cancelled',
      () => assert.fail('a cancelled generation must not commit'),
      () => undefined,
    ),
    false,
  );
});
