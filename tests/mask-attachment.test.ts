import assert from 'node:assert/strict';
import test from 'node:test';
import { maskAttachmentTransform } from '../src/core/mask-attachment';

test('a nonzero attachment converts to the renderer transform exactly', () => {
  const transform = maskAttachmentTransform({
    position: [12, -7, 3],
    rotationDeg: [15, -30, 45],
    scale: 2.5,
  });
  assert.deepEqual(transform.position, [12, -7, 3]);
  assert.equal(transform.scale, 2.5);
  const expected = [15, -30, 45].map((degrees) => (degrees * Math.PI) / 180);
  assert.deepEqual(transform.rotationRad, expected);
});

test('the default attachment is an identity transform', () => {
  const transform = maskAttachmentTransform({ position: [0, 0, 0], rotationDeg: [0, 0, 0], scale: 1 });
  assert.deepEqual(transform.position, [0, 0, 0]);
  assert.deepEqual(transform.rotationRad, [0, 0, 0]);
  assert.equal(transform.scale, 1);
});
