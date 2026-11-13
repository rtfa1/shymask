import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COLOR_TREATMENTS,
  EFFECT_OPTIONS,
  getEffectLabel,
  getTreatment,
  isMaskEffect,
} from '../src/core/treatments';

test('at least three color treatments are declared, plus explicit No effect and Rigid mask options', () => {
  assert.ok(COLOR_TREATMENTS.length >= 3);
  assert.equal(EFFECT_OPTIONS[0]?.id, 'none');
  assert.equal(EFFECT_OPTIONS[0]?.label, 'No effect');
  assert.deepEqual(
    EFFECT_OPTIONS.filter((option) => option.id !== 'none').map((option) => option.label),
    ['Rigid mask', 'Warm tint', 'Cool tint', 'Monochrome'],
  );
});

test('each color treatment declares a distinct canvas filter', () => {
  const filters = COLOR_TREATMENTS.map((treatment) => treatment.cssFilter);
  assert.equal(new Set(filters).size, filters.length);
  for (const filter of filters) assert.match(filter, /[a-z]\(/);
});

test('No effect and the rigid mask resolve to no color treatment', () => {
  assert.equal(getTreatment('none'), null);
  assert.equal(getEffectLabel('none'), 'No effect');
  assert.equal(getTreatment('mask'), null);
  assert.equal(getEffectLabel('mask'), 'Rigid mask');
  assert.equal(isMaskEffect('mask'), true);
  assert.equal(isMaskEffect('warm'), false);
  const warm = getTreatment('warm');
  assert.ok(warm);
  assert.equal(warm.id, 'warm');
});
