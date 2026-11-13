import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SECONDARY_MOTION_LIMITS,
  SECONDARY_MOTION_RUNTIME,
  type SecondaryMotionPart,
} from '../src/core/effect-package-contract';
import {
  SecondaryMotionSimulator,
  secondaryMotionAnglesRadians,
  shortestAngleDeltaDegrees,
} from '../src/core/secondary-motion';

const STEP_MS = SECONDARY_MOTION_RUNTIME.maxSubStepMs;

function part(overrides: Partial<SecondaryMotionPart> = {}): SecondaryMotionPart {
  return {
    node: 'ear',
    axis: 'y',
    drive: 'yaw',
    stiffness: 80,
    damping: 0.3,
    maxAngleDeg: 22,
    restAngleDeg: 0,
    ...overrides,
  };
}

function drive(
  simulator: SecondaryMotionSimulator,
  samples: Array<{ timeMs: number; yawDeg?: number; pitchDeg?: number; rollDeg?: number }>,
): ReturnType<SecondaryMotionSimulator['update']>[] {
  return samples.map((sample) =>
    simulator.update({
      yawDeg: sample.yawDeg ?? 0,
      pitchDeg: sample.pitchDeg ?? 0,
      rollDeg: sample.rollDeg ?? 0,
      timeMs: sample.timeMs,
    }),
  );
}

test('shortestAngleDeltaDegrees wraps through the 180 degree boundary', () => {
  assert.equal(shortestAngleDeltaDegrees(170, -170), 20);
  assert.equal(shortestAngleDeltaDegrees(-170, 170), -20);
  assert.equal(shortestAngleDeltaDegrees(10, 10), 0);
  assert.ok(Math.abs(shortestAngleDeltaDegrees(0, 180) + 180) < 1e-9);
});

test('a sustained drive never moves a part past its declared maximum angle', () => {
  const maximum = 22;
  const simulator = new SecondaryMotionSimulator({ parts: [part({ maxAngleDeg: maximum })] });
  const samples = [{ timeMs: 0, yawDeg: 0 }];
  // 900 deg/s is below the documented discontinuity speed but saturates the
  // drive (full scale is 45 deg/s), so this is the worst bounded case.
  for (let index = 1; index <= 600; index += 1) {
    samples.push({ timeMs: index * 8, yawDeg: index * 8 * 0.9 });
  }
  const frames = drive(simulator, samples);
  const observedMaximum = Math.max(...frames.map((frame) => Math.abs(frame.anglesDeg[0] ?? 0)));
  assert.ok(
    observedMaximum <= maximum + 1e-9,
    `spring angle must stay bounded by maxAngleDeg, observed ${observedMaximum}`,
  );
  assert.ok(observedMaximum > maximum * 0.9, `the saturating drive should approach the bound, got ${observedMaximum}`);
  assert.ok(frames.every((frame) => Number.isFinite(frame.anglesDeg[0] ?? 0)));
});

test('the spring keeps moving after the head stops and settles at rest', () => {
  const maximum = 22;
  // 45 deg/s is the full-scale drive, so the target is the part bound.
  const simulator = new SecondaryMotionSimulator({ parts: [part({ maxAngleDeg: maximum })] });
  const samples: Array<{ timeMs: number; yawDeg: number }> = [{ timeMs: 0, yawDeg: 0 }];
  const turnSeconds = 0.5;
  for (let timeMs = STEP_MS; timeMs <= turnSeconds * 1000; timeMs += STEP_MS) {
    samples.push({ timeMs, yawDeg: 45 * (timeMs / 1000) });
  }
  const turnEnd = turnSeconds * 1000;
  // Head is stationary from here on: the target returns to rest and the
  // underdamped spring continues with a decaying oscillation.
  for (let timeMs = turnEnd + STEP_MS; timeMs <= turnEnd + 3000; timeMs += STEP_MS) {
    samples.push({ timeMs, yawDeg: 45 * turnSeconds });
  }
  const frames = drive(simulator, samples);
  const duringTurn = frames.filter((frame) => frame.dtMs > 0 && frame.anglesDeg[0] !== undefined);
  const atTurnEnd = duringTurn.find((frame) => Math.abs(frame.anglesDeg[0] ?? 0) >= maximum * 0.25);
  assert.ok(atTurnEnd, `the turning spring must reach a visible angle, max=${Math.max(...duringTurn.map((frame) => Math.abs(frame.anglesDeg[0] ?? 0)))}`);
  const turnFrameCount = Math.floor((turnSeconds * 1000) / STEP_MS);
  const afterStop = frames.slice(turnFrameCount + 1);
  const settledAngle = Math.abs(afterStop[afterStop.length - 1]?.anglesDeg[0] ?? Number.NaN);
  assert.ok(settledAngle <= 0.5, `the spring must settle after the head stops, final angle=${settledAngle}`);
  const earlyAfterStop = afterStop.slice(0, 30);
  const maxAfterStop = Math.max(...earlyAfterStop.map((frame) => Math.abs(frame.anglesDeg[0] ?? 0)));
  assert.ok(maxAfterStop > 0.5, 'the spring must still be moving immediately after the head stops');
});

test('a time gap resets to rest instead of integrating a stale dt', () => {
  const simulator = new SecondaryMotionSimulator({ parts: [part()] });
  drive(simulator, [
    { timeMs: 0, yawDeg: 0 },
    { timeMs: 8, yawDeg: 0.5 },
    { timeMs: 16, yawDeg: 1 },
  ]);
  const before = simulator.snapshot;
  assert.equal(before.resets, 0);
  const gapFrame = simulator.update({ yawDeg: 1, pitchDeg: 0, rollDeg: 0, timeMs: 2000 });
  assert.equal(gapFrame.reset, true);
  assert.equal(gapFrame.resetReason, 'gap');
  assert.deepEqual(gapFrame.anglesDeg, [0]);
  assert.equal(simulator.snapshot.resets, 1);
  // The gap frame becomes the new continuity baseline; the next sample is a
  // normal, bounded update rather than a second reset.
  const nextFrame = simulator.update({ yawDeg: 1.5, pitchDeg: 0, rollDeg: 0, timeMs: 2008 });
  assert.equal(nextFrame.reset, false);
  assert.ok(Math.abs(nextFrame.anglesDeg[0] ?? 0) <= 22);
});

test('a pose discontinuity resets instead of injecting an impulse', () => {
  const simulator = new SecondaryMotionSimulator({ parts: [part()] });
  drive(simulator, [
    { timeMs: 0, yawDeg: 0 },
    { timeMs: 8, yawDeg: 5 },
    { timeMs: 16, yawDeg: 10 },
  ]);
  const discontinuity = simulator.update({ yawDeg: 90, pitchDeg: 0, rollDeg: 0, timeMs: 24 });
  assert.equal(discontinuity.reset, true);
  assert.equal(discontinuity.resetReason, 'discontinuity');
  assert.deepEqual(discontinuity.anglesDeg, [0]);
  const next = simulator.update({ yawDeg: 90.5, pitchDeg: 0, rollDeg: 0, timeMs: 32 });
  assert.equal(next.reset, false);
  assert.ok(Math.abs(next.anglesDeg[0] ?? 0) < 2, `no impulse after a discontinuity, got ${next.anglesDeg[0]}`);
});

test('an explicit loop-seam or reacquisition reset starts from the declared rest pose', () => {
  const simulator = new SecondaryMotionSimulator({ parts: [part()] });
  drive(simulator, [
    { timeMs: 0, yawDeg: 0 },
    { timeMs: 8, yawDeg: 5 },
    { timeMs: 16, yawDeg: 10 },
  ]);
  assert.ok(Math.abs(simulator.snapshot.anglesDeg[0] ?? 0) > 0);
  simulator.reset('loop-seam');
  assert.deepEqual(simulator.snapshot.anglesDeg, [0]);
  assert.equal(simulator.snapshot.lastResetReason, 'loop-seam');
  const afterSeam = simulator.update({ yawDeg: 10, pitchDeg: 0, rollDeg: 0, timeMs: 24 });
  assert.equal(afterSeam.reset, true);
  assert.equal(afterSeam.resetReason, 'loop-seam');
  assert.deepEqual(afterSeam.anglesDeg, [0]);

  simulator.reset('reacquisition');
  const afterReacquisition = simulator.update({ yawDeg: 10, pitchDeg: 0, rollDeg: 0, timeMs: 32 });
  assert.equal(afterReacquisition.resetReason, 'reacquisition');
  assert.deepEqual(afterReacquisition.anglesDeg, [0]);
});

test('a non-finite pose sample resets rather than producing NaN angles', () => {
  const simulator = new SecondaryMotionSimulator({ parts: [part()] });
  drive(simulator, [
    { timeMs: 0, yawDeg: 0 },
    { timeMs: 8, yawDeg: 5 },
  ]);
  const frame = simulator.update({ yawDeg: Number.NaN, pitchDeg: 0, rollDeg: 0, timeMs: 16 });
  assert.equal(frame.reset, true);
  assert.equal(frame.resetReason, 'discontinuity');
  assert.ok(frame.anglesDeg.every((angle) => Number.isFinite(angle)));
  assert.ok(Number.isFinite(frame.headSpeedDegPerSec));
});

test('parts are driven by their declared head axis only', () => {
  const simulator = new SecondaryMotionSimulator({
    parts: [
      part({ node: 'ear', drive: 'yaw', axis: 'y' }),
      part({ node: 'tuft', drive: 'pitch', axis: 'x', maxAngleDeg: 28 }),
    ],
  });
  const yawFrames = drive(simulator, [
    { timeMs: 0 },
    { timeMs: 8, yawDeg: 3 },
    { timeMs: 16, yawDeg: 6 },
    { timeMs: 24, yawDeg: 9 },
  ]);
  const yawEnd = yawFrames[yawFrames.length - 1];
  assert.ok(Math.abs(yawEnd?.anglesDeg[0] ?? 0) > 0.1, 'yaw must drive the yaw part');
  assert.ok(Math.abs(yawEnd?.anglesDeg[1] ?? 0) < 1e-9, 'yaw must not drive the pitch part');

  const pitchSimulator = new SecondaryMotionSimulator({
    parts: [
      part({ node: 'ear', drive: 'yaw', axis: 'y' }),
      part({ node: 'tuft', drive: 'pitch', axis: 'x', maxAngleDeg: 28 }),
    ],
  });
  const pitchFrames = drive(pitchSimulator, [
    { timeMs: 0 },
    { timeMs: 8, pitchDeg: 3 },
    { timeMs: 16, pitchDeg: 6 },
    { timeMs: 24, pitchDeg: 9 },
  ]);
  const pitchEnd = pitchFrames[pitchFrames.length - 1];
  assert.ok(Math.abs(pitchEnd?.anglesDeg[1] ?? 0) > 0.1, 'pitch must drive the pitch part');
  assert.ok(Math.abs(pitchEnd?.anglesDeg[0] ?? 0) < 1e-9, 'pitch must not drive the yaw part');
});

test('restAngleDeg is honored at rest and stays bounded', () => {
  const simulator = new SecondaryMotionSimulator({
    parts: [part({ restAngleDeg: 12, maxAngleDeg: 22 })],
  });
  const frames = drive(simulator, [
    { timeMs: 0 },
    { timeMs: 8 },
    { timeMs: 16 },
  ]);
  assert.ok(Math.abs((frames[2]?.anglesDeg[0] ?? 0) - 12) < 1e-9);
  simulator.reset('explicit');
  assert.deepEqual(simulator.snapshot.anglesDeg, [12]);
});

test('the equal-sub-step integration is deterministic for the same sample sequence', () => {
  const samples = [
    { timeMs: 0, yawDeg: 0 },
    { timeMs: 17, yawDeg: 1.1 },
    { timeMs: 34, yawDeg: 2.7 },
    { timeMs: 50, yawDeg: 2.9 },
    { timeMs: 67, yawDeg: 4.6 },
    { timeMs: 84, yawDeg: 4.2 },
    { timeMs: 101, yawDeg: 3.1 },
    { timeMs: 118, yawDeg: 1.4 },
    { timeMs: 135, yawDeg: 0.2 },
  ];
  const first = new SecondaryMotionSimulator({ parts: [part(), part({ node: 'tuft', axis: 'x', drive: 'pitch', maxAngleDeg: 28 })] });
  const second = new SecondaryMotionSimulator({ parts: [part(), part({ node: 'tuft', axis: 'x', drive: 'pitch', maxAngleDeg: 28 })] });
  const firstFrames = drive(first, samples);
  const secondFrames = drive(second, samples);
  assert.deepEqual(
    firstFrames.map((frame) => frame.anglesDeg),
    secondFrames.map((frame) => frame.anglesDeg),
  );
});

test('resumeAt preserves the retained spring state and then settles under a stationary pose', () => {
  const simulator = new SecondaryMotionSimulator({ parts: [part()] });
  drive(simulator, [
    { timeMs: 0, yawDeg: 0 },
    { timeMs: 8, yawDeg: 2 },
    { timeMs: 16, yawDeg: 5 },
    { timeMs: 24, yawDeg: 9 },
    { timeMs: 32, yawDeg: 14 },
  ]);
  const before = simulator.snapshot.anglesDeg[0] ?? 0;
  assert.ok(Math.abs(before) > 1, `the drive must leave a retained angle, got ${before}`);
  // The held-frame diagnostic advances wall-clock time while the accepted pose
  // is stationary. resumeAt must not reset the retained angle or velocity.
  simulator.resumeAt({ yawDeg: 14, pitchDeg: 0, rollDeg: 0, timeMs: 5000 });
  assert.equal(simulator.snapshot.anglesDeg[0], before);
  let frame = simulator.update({ yawDeg: 14, pitchDeg: 0, rollDeg: 0, timeMs: 5008 });
  assert.equal(frame.reset, false);
  for (let timeMs = 5016; timeMs <= 7000; timeMs += 8) {
    frame = simulator.update({ yawDeg: 14, pitchDeg: 0, rollDeg: 0, timeMs });
  }
  assert.ok(
    Math.abs(frame.anglesDeg[0] ?? 0) < Math.abs(before) * 0.25,
    `the held stationary pose must settle the spring (before=${before}, after=${frame.anglesDeg[0]})`,
  );
});

test('the validation bounds and fixed runtime constants are pinned', () => {
  // Validation bounds the package contract documents.
  assert.equal(SECONDARY_MOTION_LIMITS.maxParts, 4);
  assert.equal(SECONDARY_MOTION_LIMITS.maxNodeNameLength, 64);
  assert.deepEqual(
    [SECONDARY_MOTION_LIMITS.minStiffness, SECONDARY_MOTION_LIMITS.maxStiffness],
    [4, 400],
  );
  assert.deepEqual(
    [SECONDARY_MOTION_LIMITS.minDampingRatio, SECONDARY_MOTION_LIMITS.maxDampingRatio],
    [0.05, 1.5],
  );
  assert.deepEqual(
    [SECONDARY_MOTION_LIMITS.minMaxAngleDeg, SECONDARY_MOTION_LIMITS.maxMaxAngleDeg],
    [1, 60],
  );
  assert.equal(SECONDARY_MOTION_LIMITS.maxRestAngleDeg, 60);
  // Runtime constants the simulator uses, pinned so a doc/code drift fails here.
  assert.equal(SECONDARY_MOTION_RUNTIME.driveFullScaleDegPerSec, 45);
  assert.equal(SECONDARY_MOTION_RUNTIME.maxSubStepMs, 1000 / 120);
  assert.equal(SECONDARY_MOTION_RUNTIME.minDtMs, 0.5);
  assert.equal(SECONDARY_MOTION_RUNTIME.maxGapMs, 250);
  assert.equal(SECONDARY_MOTION_RUNTIME.maxPoseDeltaDeg, 45);
  assert.equal(SECONDARY_MOTION_RUNTIME.maxHeadSpeedDegPerSec, 1080);
  assert.ok(SECONDARY_MOTION_RUNTIME.maxGapMs > SECONDARY_MOTION_RUNTIME.maxSubStepMs);
  const radians = secondaryMotionAnglesRadians([180, -90, 0]);
  assert.ok(Math.abs((radians[0] ?? 0) - Math.PI) < 1e-9);
  assert.ok(Math.abs((radians[1] ?? 0) + Math.PI / 2) < 1e-9);
  assert.equal(radians[2], 0);
});
