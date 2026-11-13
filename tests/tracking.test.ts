import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceptsDetectedPose,
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

test('a face returning at a different pose after a loss gap still reacquires', () => {
  const machine = new TrackingStateMachine();
  const zero = sample({ faceCount: 0, landmarkCount: 0, hasTransform: false, pose: null });
  machine.reset(0);
  machine.update(sample(), 100);
  machine.update(sample(), 400);
  assert.equal(machine.snapshot(400).phase, 'tracking');

  // Longer than the grace window: the output pauses and the pre-loss pose is
  // no longer a valid reference.
  const lostAt = 400 + TRACKING_LIMITS.lostGraceMs + 10;
  machine.update(zero, lostAt);
  assert.equal(machine.snapshot(lostAt).phase, 'lost');

  // The person legitimately turned while the output was paused: a 90 degree
  // yaw change is greater than the per-sample jump limit, but this is a
  // reacquisition after a gap, not a single glitched frame.
  const turned = sample({ pose: { yawDeg: 90, pitchDeg: 0, rollDeg: 0, tx: 0, ty: 0, tz: -56 } });
  const reacquiredAt = lostAt + 200;
  assert.equal(machine.classify(turned), 'reliable');
  assert.equal(machine.update(turned, reacquiredAt).phase, 'lost');
  // The recovery window still applies before the output is restored.
  assert.equal(machine.update(turned, reacquiredAt + TRACKING_LIMITS.recoveryConfirmMs - 1).phase, 'lost');
  assert.equal(machine.update(turned, reacquiredAt + TRACKING_LIMITS.recoveryConfirmMs).phase, 'tracking');
});

test('multiple faces returning as one face at a different pose recovers', () => {
  const machine = new TrackingStateMachine();
  machine.reset(0);
  machine.update(sample(), 100);
  machine.update(sample(), 400);
  assert.equal(machine.update(sample({ faceCount: 2 }), 440).phase, 'multiple-faces');
  // The second person left and the remaining person is at a large pose change
  // from the pre-multiple pose; the pause reason must not veto reacquisition.
  const turned = sample({ pose: { yawDeg: -90, pitchDeg: 0, rollDeg: 0, tx: 0, ty: 0, tz: -56 } });
  const recoveredAt = 600;
  assert.equal(machine.classify(turned), 'reliable');
  assert.equal(machine.update(turned, recoveredAt).phase, 'multiple-faces');
  assert.equal(machine.update(turned, recoveredAt + TRACKING_LIMITS.recoveryConfirmMs).phase, 'tracking');
});

test('a single glitched pose-jump frame during continuous tracking is never accepted', () => {
  const machine = new TrackingStateMachine();
  machine.reset(0);
  machine.update(sample(), 100);
  machine.update(sample(), 400);
  const glitch = sample({ pose: { yawDeg: 0, pitchDeg: 0, rollDeg: 0, tx: 0, ty: 0, tz: 20 } });
  // The guard rejects the glitch frame instead of teleporting the mask.
  assert.equal(machine.classify(glitch), 'unreliable');
  // One glitched frame inside the confirmation window alone does not pause...
  assert.equal(machine.update(glitch, 440).phase, 'tracking');
  // ...but a persistent glitch still pauses after the confirmation window.
  assert.equal(
    machine.update(glitch, 440 + TRACKING_LIMITS.unreliableConfirmMs + 10).phase,
    'unreliable',
  );
});

test('multiple faces falling back to zero faces reports tracking lost, not multiple faces', () => {
  const machine = new TrackingStateMachine();
  const zero = sample({ faceCount: 0, landmarkCount: 0, hasTransform: false, pose: null });
  machine.reset(0);
  machine.update(sample(), 100);
  machine.update(sample(), 400);
  const multipleAt = 440;
  assert.equal(machine.update(sample({ faceCount: 2 }), multipleAt).phase, 'multiple-faces');
  // The second person leaves too: the zero-face grace window starts here, so a
  // single dropped detection still reads as the multiple-face pause.
  const firstZeroAt = multipleAt + 100;
  assert.equal(machine.update(zero, firstZeroAt).phase, 'multiple-faces');
  assert.equal(
    machine.update(zero, firstZeroAt + TRACKING_LIMITS.lostGraceMs - 10).phase,
    'multiple-faces',
  );
  const lostAt = firstZeroAt + TRACKING_LIMITS.lostGraceMs + 10;
  const snapshot = machine.update(zero, lostAt);
  assert.equal(snapshot.phase, 'lost');
  assert.equal(snapshot.faceCount, 0);
  // A healthy single face then recovers through the normal recovery window.
  const reacquiredAt = lostAt + 100;
  assert.equal(machine.update(sample(), reacquiredAt).phase, 'lost');
  assert.equal(machine.update(sample(), reacquiredAt + TRACKING_LIMITS.recoveryConfirmMs).phase, 'tracking');
});


test('an outlier first recovery sample cannot latch the pose guard', () => {
  const machine = new TrackingStateMachine();
  const zero = sample({ faceCount: 0, landmarkCount: 0, hasTransform: false, pose: null });
  machine.reset(0);
  machine.update(sample(), 100);
  machine.update(sample(), 400);
  const lostAt = 400 + TRACKING_LIMITS.lostGraceMs + 10;
  machine.update(zero, lostAt);
  assert.equal(machine.snapshot(lostAt).phase, 'lost');

  // The first sample after the gap is a detector outlier: plausible on its own,
  // but a 150 degree yaw far from the person's continuing pose. The state
  // machine accepts it as reliable (there is no continuity reference after a
  // paused gap), so it must not become the permanent jump reference.
  const outlier = sample({ pose: { yawDeg: 150, pitchDeg: 0, rollDeg: 0, tx: 0, ty: 0, tz: -56 } });
  const recoveredAt = lostAt + 100;
  assert.equal(machine.classify(outlier), 'reliable');
  assert.equal(machine.update(outlier, recoveredAt).phase, 'lost');

  // The person's stable pose is a large rotation away from that outlier. If the
  // outlier had seeded the jump reference every stable sample would be rejected
  // as unreliable and the phase would stay `lost` forever. The recovery window
  // still applies before output is restored.
  const stable = sample({ pose: { yawDeg: -90, pitchDeg: 0, rollDeg: 0, tx: 0, ty: 0, tz: -56 } });
  const midRecovery = machine.update(stable, recoveredAt + 100);
  assert.equal(midRecovery.phase, 'lost');
  assert.equal(midRecovery.classification, 'reliable');
  const recovered = machine.update(stable, recoveredAt + TRACKING_LIMITS.recoveryConfirmMs);
  assert.equal(recovered.phase, 'tracking');
  assert.equal(recovered.classification, 'reliable');
});

test('the projection gate rejects a sample classified unreliable while tracking continues', () => {
  const machine = new TrackingStateMachine();
  machine.reset(0);
  machine.update(sample(), 100);
  machine.update(sample(), 400);
  const glitch = sample({ pose: { yawDeg: 0, pitchDeg: 0, rollDeg: 0, tx: 0, ty: 0, tz: 20 } });
  const rejected = machine.update(glitch, 440);
  // The phase stays `tracking` inside the confirmation window, so the phase
  // alone cannot gate the projection; the sample classification must.
  assert.equal(rejected.phase, 'tracking');
  assert.equal(rejected.classification, 'unreliable');
  assert.equal(acceptsDetectedPose(rejected), false);
  const accepted = machine.update(sample(), 480);
  assert.equal(accepted.phase, 'tracking');
  assert.equal(accepted.classification, 'reliable');
  assert.equal(acceptsDetectedPose(accepted), true);
});

test('no sample has been accepted before the first tracker update', () => {
  assert.equal(initialTrackingSnapshot(0).classification, null);
  assert.equal(acceptsDetectedPose(initialTrackingSnapshot(0)), false);
});

test('multiple faces falling back to one unreliable face reports unreliable, not multiple faces', () => {
  const machine = new TrackingStateMachine();
  machine.reset(0);
  machine.update(sample(), 100);
  machine.update(sample(), 400);
  assert.equal(machine.update(sample({ faceCount: 2 }), 440).phase, 'multiple-faces');
  const unreliable = sample({ landmarkCount: 120, hasTransform: false, pose: null });
  const firstUnreliableAt = 500;
  const stillMultiple = machine.update(unreliable, firstUnreliableAt);
  assert.equal(stillMultiple.phase, 'multiple-faces');
  assert.equal(stillMultiple.faceCount, 1);
  assert.equal(
    machine.update(unreliable, firstUnreliableAt + TRACKING_LIMITS.unreliableConfirmMs - 10).phase,
    'multiple-faces',
  );
  const switched = machine.update(unreliable, firstUnreliableAt + TRACKING_LIMITS.unreliableConfirmMs + 10);
  assert.equal(switched.phase, 'unreliable');
  assert.equal(switched.faceCount, 1);
  // A healthy face still recovers through the normal recovery window.
  const recoveredAt = firstUnreliableAt + TRACKING_LIMITS.unreliableConfirmMs + 20;
  assert.equal(machine.update(sample(), recoveredAt).phase, 'unreliable');
  assert.equal(machine.update(sample(), recoveredAt + TRACKING_LIMITS.recoveryConfirmMs).phase, 'tracking');
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
