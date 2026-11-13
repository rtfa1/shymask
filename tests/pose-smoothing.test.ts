import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CANONICAL_FACE_INDICES,
  CANONICAL_FACE_POSITIONS,
  CANONICAL_FACE_TRIANGLE_COUNT,
  CANONICAL_FACE_VERTEX_COUNT,
} from '../src/renderer/canonical-face';
import { POSE_SMOOTHING_LIMITS, PoseSmoother } from '../src/core/pose-smoothing';

/** Column-major rigid transform from an XYZ-order rotation and translation. */
function eulerPoseMatrix(
  tx: number,
  ty: number,
  tz: number,
  pitchDeg: number,
  yawDeg: number,
  rollDeg: number,
): number[] {
  const pitch = (pitchDeg * Math.PI) / 180;
  const yaw = (yawDeg * Math.PI) / 180;
  const roll = (rollDeg * Math.PI) / 180;
  const cx = Math.cos(pitch);
  const sx = Math.sin(pitch);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cz = Math.cos(roll);
  const sz = Math.sin(roll);
  // R = Rx(pitch) * Ry(yaw) * Rz(roll), row-major.
  const r00 = cy * cz;
  const r01 = -cy * sz;
  const r02 = sy;
  const r10 = cx * sz + sx * sy * cz;
  const r11 = cx * cz - sx * sy * sz;
  const r12 = -sx * cy;
  const r20 = sx * sz - cx * sy * cz;
  const r21 = sx * cz + cx * sy * sz;
  const r22 = cx * cy;
  return [r00, r10, r20, 0, r01, r11, r21, 0, r02, r12, r22, 0, tx, ty, tz, 1];
}

/** Column-major rigid transform with a yaw rotation and per-axis translation. */
function poseMatrix(tx: number, ty: number, tz: number, yawDeg = 0): number[] {
  const yaw = (yawDeg * Math.PI) / 180;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  return [
    cos, 0, -sin, 0,
    0, 1, 0, 0,
    sin, 0, cos, 0,
    tx, ty, tz, 1,
  ];
}

function translation(matrix: ArrayLike<number>): [number, number, number] {
  return [matrix[12] as number, matrix[13] as number, matrix[14] as number];
}

function yawOf(matrix: ArrayLike<number>): number {
  return (Math.atan2(-(matrix[2] as number), matrix[0] as number) * 180) / Math.PI;
}

function secondDifference(values: number[]): number[] {
  const result: number[] = [];
  for (let index = 2; index < values.length; index += 1) {
    result.push(Math.abs(values[index] - 2 * values[index - 1] + values[index - 2]));
  }
  return result;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function assertMatrixClose(actual: ArrayLike<number>, expected: ArrayLike<number>, tolerance = 1e-6): void {
  for (let index = 0; index < 16; index += 1) {
    assert.ok(
      Math.abs((actual[index] as number) - (expected[index] as number)) <= tolerance,
      `matrix element ${index} differs: ${actual[index]} vs ${expected[index]}`,
    );
  }
}

test('canonical face occluder data is the complete MediaPipe 468-vertex face surface', () => {
  assert.equal(CANONICAL_FACE_VERTEX_COUNT, 468);
  assert.equal(CANONICAL_FACE_TRIANGLE_COUNT, 898);
  assert.equal(CANONICAL_FACE_POSITIONS.length, CANONICAL_FACE_VERTEX_COUNT * 3);
  assert.equal(CANONICAL_FACE_INDICES.length, CANONICAL_FACE_TRIANGLE_COUNT * 3);
  for (const index of CANONICAL_FACE_INDICES) {
    assert.ok(Number.isInteger(index) && index >= 0 && index < CANONICAL_FACE_VERTEX_COUNT, `bad index ${index}`);
  }
  // Canonical face coordinates are centimetres with +Z toward the camera. The
  // nose tip must be in front of the eye contour, which is what makes it the
  // first surface a depth-only face occluder hides mask fragments with.
  const zOf = (vertex: number): number => Number(CANONICAL_FACE_POSITIONS[vertex * 3 + 2]);
  assert.ok(zOf(4) > 7, `nose tip must protrude, got z=${zOf(4)}`);
  assert.ok(zOf(4) > zOf(33) + 2, 'nose tip must be in front of the eye contour');
  assert.ok(zOf(4) < 10 && zOf(0) > 5, 'canonical model must stay in face-sized centimetres');
});

test('the first smoothed sample snaps to the raw pose', () => {
  const smoother = new PoseSmoother();
  const raw = poseMatrix(1, 2, -56, 12);
  const rendered = smoother.push(raw, 1000);
  assertMatrixClose(rendered, raw);
  const stats = smoother.lastStats;
  assert.equal(stats.snapped, true);
  assert.equal(stats.alpha, 1);
});

test('matrix decomposition round-trips a combined pitch, yaw and roll pose', () => {
  const smoother = new PoseSmoother();
  const raw = eulerPoseMatrix(-3, 4, -50, 25, -35, 17);
  assertMatrixClose(smoother.push(raw, 1000), raw, 1e-5);
  // The smoothed output of a second identical sample must stay on the same pose.
  assertMatrixClose(smoother.push(raw, 1042), raw, 1e-5);
});

test('a gap longer than the smoothing bound snaps instead of trailing the face', () => {
  const smoother = new PoseSmoother();
  smoother.push(poseMatrix(0, 0, -56, 0), 1000);
  smoother.push(poseMatrix(0, 0, -56, 0), 1042);
  const jumped = poseMatrix(5, 0, -56, 30);
  const rendered = smoother.push(jumped, 1042 + POSE_SMOOTHING_LIMITS.maxGapMs + 50);
  assert.equal(smoother.lastStats.snapped, true);
  assert.deepEqual(translation(rendered), [5, 0, -56]);
  assert.ok(Math.abs(yawOf(rendered) - 30) < 1e-6);
});

test('rest-pose jitter is measurably reduced by the base gain', () => {
  const smoother = new PoseSmoother();
  const rawX: number[] = [];
  const smoothX: number[] = [];
  // Sub-centimetre, sub-degree per-frame residuals: the noise scale the filter
  // is meant to damp. Large per-frame jumps are motion and must pass through.
  const noise = [0, 0.14, -0.1, 0.18, -0.16, 0.08, -0.12, 0.16, -0.06, 0.1];
  for (let index = 0; index < 80; index += 1) {
    const offset = noise[index % noise.length] as number;
    const raw = poseMatrix(offset, 0, -56, offset * 2);
    rawX.push(translation(raw)[0]);
    smoothX.push(translation(smoother.push(raw, 1000 + index * (1000 / 24)))[0]);
  }
  const rawJitter = mean(secondDifference(rawX.slice(1)));
  const smoothJitter = mean(secondDifference(smoothX.slice(1)));
  assert.ok(
    smoothJitter < rawJitter * 0.75,
    `expected the smoother to reduce second-difference jitter, raw=${rawJitter} smooth=${smoothJitter}`,
  );
  assert.equal(smoother.lastStats.snapped, false);
});

test('fast recorded motion passes through without added lag', () => {
  const smoother = new PoseSmoother();
  const frameMs = 1000 / 24;
  // 60 cm/s is the documented full-trust translation speed.
  for (let index = 0; index < 30; index += 1) smoother.push(poseMatrix(index * 2.5, 0, -56), 1000 + index * frameMs);
  const stats = smoother.lastStats;
  assert.ok(stats.alpha > 0.99, `fast motion must raise the gain, got ${stats.alpha}`);
  assert.ok(stats.rampLagMs < 1, `fast motion must not add ramp lag, got ${stats.rampLagMs}ms`);
  assert.ok(stats.translationLagCm < 0.05, `fast motion must not trail, got ${stats.translationLagCm}cm`);
});

test('constant-velocity lag is bounded by the documented base-gain reference bound', () => {
  const smoother = new PoseSmoother();
  const frameMs = 1000 / 24;
  // Slow constant motion: the adaptive gain stays near the base gain.
  for (let index = 0; index < 60; index += 1) smoother.push(poseMatrix(index * 0.05, 0, -56), 1000 + index * frameMs);
  const stats = smoother.lastStats;
  assert.ok(stats.alpha >= POSE_SMOOTHING_LIMITS.baseAlpha - 1e-9);
  assert.ok(
    stats.rampLagMs <= smoother.referenceRampLagMs + 1,
    `ramp lag ${stats.rampLagMs}ms must stay under the documented ${smoother.referenceRampLagMs}ms reference-interval bound`,
  );
  assert.ok(stats.translationLagCm <= POSE_SMOOTHING_LIMITS.maxTranslationLagCm);
});

test('measured lag never exceeds the documented safety caps across a noisy sequence', () => {
  const smoother = new PoseSmoother();
  for (let index = 0; index < 100; index += 1) {
    const phase = index * 0.7;
    const raw = poseMatrix(
      Math.sin(phase) * 8,
      Math.cos(phase * 0.9) * 4,
      -56,
      Math.sin(phase * 0.5) * 55,
    );
    smoother.push(raw, 1000 + index * (1000 / 24));
    assert.ok(
      smoother.lastStats.translationLagCm <= POSE_SMOOTHING_LIMITS.maxTranslationLagCm + 1e-9,
      `translation lag ${smoother.lastStats.translationLagCm}cm exceeded the cap`,
    );
    assert.ok(
      smoother.lastStats.rotationLagDeg <= POSE_SMOOTHING_LIMITS.maxRotationLagDeg + 1e-9,
      `rotation lag ${smoother.lastStats.rotationLagDeg}deg exceeded the cap`,
    );
  }
});

test('reset discards stale history so recovery snaps to the new pose', () => {
  const smoother = new PoseSmoother();
  for (let index = 0; index < 10; index += 1) smoother.push(poseMatrix(index, 0, -56, index), 1000 + index * 42);
  smoother.reset();
  const recovered = poseMatrix(-12, 3, -50, -40);
  assertMatrixClose(smoother.push(recovered, 2000), recovered);
  assert.equal(smoother.lastStats.snapped, true);
  assert.equal(smoother.snapshot.samples, 1);
});
