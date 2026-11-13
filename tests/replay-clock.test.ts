import assert from 'node:assert/strict';
import test from 'node:test';
import { LOOP_SEAM_THRESHOLD_MS, ReplayTimeline } from '../src/core/replay-clock';

const LOOP_SECONDS = 3.379;
const FRAME_MS = 1000 / 30;

function replayFrames(loops: number): Array<{ mediaTimeSeconds: number; presentedAtMs: number }> {
  const frames: Array<{ mediaTimeSeconds: number; presentedAtMs: number }> = [];
  let presentedAtMs = 500;
  const framesPerLoop = Math.round((LOOP_SECONDS * 1000) / FRAME_MS);
  for (let loop = 0; loop < loops; loop += 1) {
    for (let frame = 0; frame < framesPerLoop; frame += 1) {
      frames.push({ mediaTimeSeconds: (frame * FRAME_MS) / 1000, presentedAtMs });
      presentedAtMs += FRAME_MS;
    }
  }
  return frames;
}

test('processing timestamps stay valid and increasing across three loops', () => {
  const timeline = new ReplayTimeline();
  const timestamps = replayFrames(3).map((frame) =>
    timeline.record({ ...frame, loopDurationSeconds: LOOP_SECONDS }),
  );

  assert.equal(timestamps.every((timestamp) => timestamp.valid), true);
  assert.equal(timestamps.every((timestamp) => timestamp.increasing), true);
  for (let index = 1; index < timestamps.length; index += 1) {
    assert.ok(
      (timestamps[index]?.processingTimestampMs ?? 0) > (timestamps[index - 1]?.processingTimestampMs ?? 0),
    );
  }
  assert.equal(timeline.loops, 2);
  assert.equal(timeline.seams, 2);
  const finalTimestamp = timestamps[timestamps.length - 1];
  assert.ok(finalTimestamp !== undefined);
  assert.ok(finalTimestamp.processingTimestampMs > 2 * LOOP_SECONDS * 1000);
});

test('a media-time reset is reported as a deliberate loop seam, not a regression', () => {
  const timeline = new ReplayTimeline();
  const before = timeline.record({ mediaTimeSeconds: LOOP_SECONDS - 0.05, presentedAtMs: 1000, loopDurationSeconds: LOOP_SECONDS });
  const after = timeline.record({ mediaTimeSeconds: 0.02, presentedAtMs: 1050, loopDurationSeconds: LOOP_SECONDS });
  assert.equal(before.loopSeam, false);
  assert.equal(after.loopSeam, true);
  assert.equal(after.valid, true);
  assert.ok(after.processingTimestampMs > before.processingTimestampMs);
  assert.equal(timeline.seams, 1);
});

test('a small backward media-time jitter is not treated as a loop seam', () => {
  const timeline = new ReplayTimeline();
  timeline.record({ mediaTimeSeconds: 2.0, presentedAtMs: 100, loopDurationSeconds: LOOP_SECONDS });
  const jitter = timeline.record({ mediaTimeSeconds: 1.99, presentedAtMs: 133, loopDurationSeconds: LOOP_SECONDS });
  assert.equal(jitter.loopSeam, false);
  assert.ok(LOOP_SEAM_THRESHOLD_MS > 10);
  // The timestamp regressed, so the frame is rejected rather than silently replayed.
  assert.equal(jitter.valid, false);
  assert.equal(jitter.increasing, false);
});

test('non-finite frame metadata is rejected instead of being presented', () => {
  const timeline = new ReplayTimeline();
  const timestamp = timeline.record({ mediaTimeSeconds: Number.NaN, presentedAtMs: 100, loopDurationSeconds: LOOP_SECONDS });
  assert.equal(timestamp.valid, false);
  assert.match(timestamp.invalidReason ?? '', /non-finite/);
});

test('reset clears loop accounting for a re-selected input', () => {
  const timeline = new ReplayTimeline();
  timeline.record({ mediaTimeSeconds: 3.0, presentedAtMs: 100, loopDurationSeconds: LOOP_SECONDS });
  timeline.record({ mediaTimeSeconds: 0.1, presentedAtMs: 133, loopDurationSeconds: LOOP_SECONDS });
  assert.equal(timeline.seams, 1);
  timeline.reset();
  assert.equal(timeline.loops, 0);
  assert.equal(timeline.seams, 0);
  const first = timeline.record({ mediaTimeSeconds: 0.1, presentedAtMs: 200, loopDurationSeconds: LOOP_SECONDS });
  assert.equal(first.valid, true);
  assert.equal(first.loopIndex, 0);
});
