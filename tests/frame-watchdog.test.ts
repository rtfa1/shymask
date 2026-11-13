import assert from 'node:assert/strict';
import test from 'node:test';
import { DECODE_STALL_THRESHOLD_MS, FrameWatchdog } from '../src/core/frame-watchdog';

test('the stall threshold matches the documented 250 ms decode-gap limit', () => {
  assert.equal(DECODE_STALL_THRESHOLD_MS, 250);
});

test('a decoder that stops presenting frames trips the watchdog after the threshold', () => {
  const watchdog = new FrameWatchdog();
  watchdog.arm(1_000);
  watchdog.noteFrame(1_040);
  // 160 ms after the last presented frame: still tolerated.
  assert.equal(watchdog.check(1_200, true), false);
  // Exactly at the threshold: the documented rule is "longer than 250 ms".
  assert.equal(watchdog.check(1_290, true), false);
  // One millisecond past it: the output must be hidden.
  assert.equal(watchdog.check(1_291, true), true);
  assert.equal(watchdog.isStalled, true);
});

test('a single missed frame within the threshold does not hide output at a loop seam', () => {
  const watchdog = new FrameWatchdog();
  watchdog.arm(2_000);
  watchdog.noteFrame(2_000);
  // One ~24 Hz presented-frame gap, then the seam frame arrives.
  assert.equal(watchdog.check(2_060, true), false);
  watchdog.noteFrame(2_080);
  assert.equal(watchdog.check(2_200, true), false);
  assert.equal(watchdog.isStalled, false);
});

test('the next presented frame clears an active stall automatically', () => {
  const watchdog = new FrameWatchdog();
  watchdog.arm(3_000);
  watchdog.noteFrame(3_000);
  assert.equal(watchdog.check(3_400, true), true);
  watchdog.noteFrame(3_420);
  assert.equal(watchdog.check(3_500, true), false);
  assert.equal(watchdog.isStalled, false);
});

test('no expectation clears the watchdog while paused or without an effect', () => {
  const watchdog = new FrameWatchdog();
  watchdog.arm(4_000);
  watchdog.noteFrame(4_000);
  assert.equal(watchdog.check(4_500, true), true);
  // Manual pause, no active effect or a recheck binds no expectation.
  assert.equal(watchdog.check(4_500, false), false);
  assert.equal(watchdog.isStalled, false);
});

test('disarm drops a stale baseline so Resume starts a fresh window', () => {
  const watchdog = new FrameWatchdog();
  watchdog.arm(5_000);
  watchdog.noteFrame(5_010);
  watchdog.disarm();
  // Without a baseline a check cannot trip even after a long pause.
  assert.equal(watchdog.check(60_000, true), false);
  // Resume establishes the new baseline.
  watchdog.arm(60_000);
  assert.equal(watchdog.check(60_100, true), false);
  assert.equal(watchdog.check(60_300, true), true);
});
