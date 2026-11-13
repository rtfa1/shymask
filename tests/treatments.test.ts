import assert from 'node:assert/strict';
import test from 'node:test';
import { COLOR_TREATMENTS, EFFECT_OPTIONS, getEffectLabel, getTreatment } from '../src/core/treatments';

test('at least three color treatments are declared, plus an explicit No effect option', () => {
  assert.ok(COLOR_TREATMENTS.length >= 3);
  assert.equal(EFFECT_OPTIONS[0]?.id, 'none');
  assert.equal(EFFECT_OPTIONS[0]?.label, 'No effect');
});

test('each treatment declares a distinct canvas filter', () => {
  const filters = COLOR_TREATMENTS.map((treatment) => treatment.cssFilter);
  assert.equal(new Set(filters).size, filters.length);
  for (const filter of filters) assert.match(filter, /[a-z]\(/);
});

test('No effect resolves to no treatment so the policy can hide output', () => {
  assert.equal(getTreatment('none'), null);
  assert.equal(getEffectLabel('none'), 'No effect');
  const warm = getTreatment('warm');
  assert.ok(warm);
  assert.equal(warm.id, 'warm');
});
