import assert from 'node:assert/strict';
import test from 'node:test';
import type { FaceDistortionParameters } from '../src/core/effect-package-contract';
import { faceDistortionContains, faceDistortionGeometry } from '../src/core/face-distortion';

function parameters(overrides: Partial<FaceDistortionParameters> = {}): FaceDistortionParameters {
  return { mode: 'bulge', strength: 0.6, radiusScale: 1.35, centerOffset: [0, 0], ...overrides };
}

const FACE = { x: 0.25, y: 0.2, width: 0.4, height: 0.5 };

test('the warp ellipse is centered on the tracked face box and scales with it', () => {
  const geometry = faceDistortionGeometry(FACE, parameters());
  assert.ok(Math.abs(geometry.centerX - 0.45) < 1e-9);
  assert.ok(Math.abs(geometry.centerY - 0.45) < 1e-9);
  assert.ok(Math.abs(geometry.radiusX - 0.27) < 1e-9);
  assert.ok(Math.abs(geometry.radiusY - 0.3375) < 1e-9);
  // 0.6 strength * the fixed 0.75 maximum warp factor.
  assert.ok(Math.abs(geometry.warpFactor - 0.45) < 1e-9);
});

test('the warp follows the recorded face: movement and distance change the ellipse', () => {
  const initial = faceDistortionGeometry(FACE, parameters());
  const moved = faceDistortionGeometry({ ...FACE, x: 0.4, y: 0.1 }, parameters());
  assert.ok(moved.centerX > initial.centerX && moved.centerY < initial.centerY);
  assert.equal(moved.radiusX, initial.radiusX, 'translation must not change the warp size');

  const closer = faceDistortionGeometry(
    { ...FACE, width: FACE.width * 1.5, height: FACE.height * 1.5 },
    parameters(),
  );
  assert.ok(closer.radiusX > initial.radiusX && closer.radiusY > initial.radiusY);
});

test('centerOffset moves the warp relative to the face in bounded face-relative units', () => {
  const geometry = faceDistortionGeometry(FACE, parameters({ centerOffset: [0.25, -0.25] }));
  assert.ok(Math.abs(geometry.centerX - (0.25 + 0.4 * 0.75)) < 1e-9);
  assert.ok(Math.abs(geometry.centerY - (0.2 + 0.5 * 0.25)) < 1e-9);
});

test('pinch reverses the displacement direction and strength 0 is a no-op warp', () => {
  const pinch = faceDistortionGeometry(FACE, parameters({ mode: 'pinch' }));
  assert.ok(pinch.warpFactor < 0);
  assert.ok(Math.abs(pinch.warpFactor + 0.45) < 1e-9);
  assert.equal(faceDistortionGeometry(FACE, parameters({ strength: 0 })).warpFactor, 0);
});

test('the pure mapping clamps out-of-bounds values as defense in depth', () => {
  // Validation rejects these, but the renderer must never receive an unbounded
  // displacement even if a future caller bypasses validation.
  const geometry = faceDistortionGeometry(FACE, parameters({ strength: 5, radiusScale: 0 }));
  assert.ok(Math.abs(geometry.warpFactor - 0.75) < 1e-9);
  assert.ok(geometry.radiusX > 0 && geometry.radiusY > 0);

  const wide = faceDistortionGeometry(FACE, parameters({ radiusScale: 100 }));
  assert.ok(Math.abs(wide.radiusX - (FACE.width / 2) * 2.5) < 1e-9);
});

test('the ellipse containment test matches the shader region', () => {
  const geometry = faceDistortionGeometry(FACE, parameters());
  assert.equal(faceDistortionContains(geometry, geometry.centerX, geometry.centerY), true);
  assert.equal(faceDistortionContains(geometry, 0.01, 0.01), false);
  assert.equal(
    faceDistortionContains(geometry, geometry.centerX + geometry.radiusX * 0.99, geometry.centerY),
    true,
  );
  assert.equal(
    faceDistortionContains(geometry, geometry.centerX + geometry.radiusX * 1.01, geometry.centerY),
    false,
  );
});
