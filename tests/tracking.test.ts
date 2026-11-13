import assert from 'node:assert/strict';
import test from 'node:test';
import {
  initialTrackingSnapshot,
  poseFromColumnMajorMatrix,
  TrackingStateMachine,
  TRACKING_LIMITS,
  type TrackingSample,
} from '../src/core/tracking';

function sample(overrides: Partial<TrackingSample> = {}): TrackingSample {
  return {
    faceCount: 1,
    landmarkCount: 478,
    hasTransform: true,
    faceWidthRatio: 0.2,
    pose: { yawDeg: 0, pitchDeg: 0, rollDeg: 0, tx: 0, ty: 0, tz: -56 },
    ...overrides,
  };
}

test('tracking starts in initializing and pauses until one reliable face is seen', () => {
  const machine = new TrackingStateMachine();
  machine.reset(0);
  assert.equal(machine.snapshot(0).phase, 'initializing');
  assert.equal(machine.update(sample(), 100).phase, 'initializing');
  // The recovery window must elapse before output is restored.
  assert.equal(machine.update(sample(), 300).phase, 'initializing');
  assert.equal(machine.update(sample(), 400).phase, 'tracking');
});

test('a single dropped detection within the grace window does not pause output', () => {
  const machine = new TrackingStateMachine();
  machine.reset(0);
  machine.update(sample(), 100);
  machine.update(sample(), 400);
  assert.equal(machine.snapshot(400).phase, 'tracking');
  assert.equal(machine.update(sample({ faceCount: 0, landmarkCount: 0, hasTransform: false, pose: null }), 500).phase, 'tracking');
  // One 24 Hz frame later the face is back: still tracking.
  assert.equal(machine.update(sample(), 540).phase, 'tracking');
  assert.equal(machine.snapshot(540).phase, 'tracking');
});

test('zero faces beyond the grace window becomes tracking-lost', () => {
  const machine = new TrackingStateMachine();
  machine.reset(0);
  machine.update(sample(), 100);
  machine.update(sample(), 400);
  const lostAt = 400 + TRACKING_LIMITS.lostGraceMs + 10;
  const snapshot = machine.update(sample({ faceCount: 0, landmarkCount: 0, hasTransform: false, pose: null }), lostAt);
  assert.equal(snapshot.phase, 'lost');
  assert.equal(snapshot.faceCount, 0);
  assert.ok(snapshot.sinceGoodMs !== null && snapshot.sinceGoodMs > TRACKING_LIMITS.lostGraceMs);
});

test('multiple faces pause immediately and require a confirmed single face to recover', () => {
  const machine = new TrackingStateMachine();
  machine.reset(0);
  machine.update(sample(), 100);
  machine.update(sample(), 400);
  assert.equal(machine.update(sample({ faceCount: 2 }), 440).phase, 'multiple-faces');
  // Even one reliable face is not enough during the recovery window.
  assert.equal(machine.update(sample(), 480).phase, 'multiple-faces');
  assert.equal(machine.update(sample(), 700).phase, 'multiple-faces');
  assert.equal(machine.update(sample(), 800).phase, 'tracking');
});

test('an unreliable face pauses after its confirmation window, not immediately', () => {
  const machine = new TrackingStateMachine();
  machine.reset(0);
  machine.update(sample(), 100);
  machine.update(sample(), 400);
  const unreliable = sample({ landmarkCount: 120, hasTransform: false, pose: null });
  assert.equal(machine.update(unreliable, 450).phase, 'tracking');
  assert.equal(
    machine.update(unreliable, 450 + TRACKING_LIMITS.unreliableConfirmMs + 10).phase,
    'unreliable',
  );
});

test('an implausible pose jump is treated as unreliable rather than teleporting the mask', () => {
  const machine = new TrackingStateMachine();
  machine.reset(0);
  machine.update(sample(), 100);
  machine.update(sample(), 400);
  const jumped = sample({ pose: { yawDeg: 0, pitchDeg: 0, rollDeg: 0, tx: 0, ty: 0, tz: 20 } });
  assert.equal(machine.classify(jumped), 'unreliable');
  assert.equal(machine.update(jumped, 440).phase, 'tracking');
  assert.equal(machine.update(jumped, 1000).phase, 'unreliable');
});

test('recovery from loss requires one reliable face for the recovery window', () => {
  const machine = new TrackingStateMachine();
  const zero = sample({ faceCount: 0, landmarkCount: 0, hasTransform: false, pose: null });
  machine.reset(0);
  machine.update(zero, 0);
  assert.equal(machine.update(zero, TRACKING_LIMITS.lostGraceMs + 10).phase, 'lost');
  // First reliable sample starts the confirmation window.
  assert.equal(machine.update(sample(), 600).phase, 'lost');
  assert.equal(machine.update(sample(), 850).phase, 'lost');
  assert.equal(machine.update(sample(), 1000).phase, 'tracking');
});

test('injected samples are labelled but use the same transitions', () => {
  const machine = new TrackingStateMachine();
  machine.reset(0);
  machine.update(sample(), 100);
  machine.update(sample(), 400);
  const snapshot = machine.update(sample({ faceCount: 2 }), 440, true);
  assert.equal(snapshot.phase, 'multiple-faces');
  assert.equal(snapshot.injected, true);
});

test('reset returns the machine to readiness before a new replay starts', () => {
  const machine = new TrackingStateMachine();
  machine.reset(0);
  machine.update(sample(), 100);
  machine.update(sample(), 400);
  assert.equal(machine.snapshot(400).phase, 'tracking');
  machine.reset(1000);
  const snapshot = machine.snapshot(1000);
  assert.equal(snapshot.phase, 'initializing');
  assert.equal(snapshot.lastGoodAtMs, null);
  assert.deepEqual(snapshot, initialTrackingSnapshot(1000));
});

test('the MediaPipe matrix is decomposed in column-major order', () => {
  // A frontal face translated 3 cm right, 15 cm up and 56 cm in front, with a
  // 12.5 degree pitch (the observed fixture pose shape).
  const matrix = [
    0.994, 0.102, -0.031, 0,
    -0.093, 0.972, 0.216, 0,
    0.052, -0.212, 0.976, 0,
    -3.5, 15.5, -57.8, 1,
  ];
  const pose = poseFromColumnMajorMatrix(matrix);
  assert.ok(pose);
  assert.equal(pose.tx, -3.5);
  assert.equal(pose.ty, 15.5);
  assert.equal(pose.tz, -57.8);
  assert.ok(Math.abs(pose.pitchDeg - -12.5) < 0.6, `pitch ${pose.pitchDeg}`);
  assert.ok(Math.abs(pose.yawDeg - -1.8) < 0.6, `yaw ${pose.yawDeg}`);
  assert.ok(Math.abs(pose.rollDeg - 6.0) < 0.6, `roll ${pose.rollDeg}`);
});

test('a malformed matrix cannot produce a pose', () => {
  assert.equal(poseFromColumnMajorMatrix([1, 2, 3]), null);
  assert.equal(poseFromColumnMajorMatrix([...new Array(15).fill(0), Number.NaN]), null);
  assert.equal(poseFromColumnMajorMatrix(new Array(16).fill(Number.NaN)), null);
});
