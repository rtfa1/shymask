import assert from 'node:assert/strict';
import test from 'node:test';
import type { FixtureInfo, FixtureMetadata } from '../src/core/bridge';
import {
  PAUSED_TITLE,
  resolveOutput,
  type PreviewState,
} from '../src/core/output-policy';

const METADATA: FixtureMetadata = {
  id: 'webcam-loop-v1',
  title: 'Test clip',
  fileName: 'webcam-loop.webm',
  sourcePage: 'https://example.invalid/file',
  originalUrl: 'https://example.invalid/file.webm',
  license: 'CC0 1.0',
  licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
  attribution: 'Test',
  sha256: 'a'.repeat(64),
  bytes: 1000,
  durationSeconds: 3.379,
  width: 1920,
  height: 1080,
  notes: 'test',
};

const READY_FIXTURE: FixtureInfo = {
  state: 'ready',
  metadata: METADATA,
  videoUrl: 'file:///C:/fixtures/cache/webcam-loop.webm',
};

function state(overrides: Partial<PreviewState> = {}): PreviewState {
  return {
    fixture: READY_FIXTURE,
    started: true,
    ready: true,
    manualPaused: false,
    effect: 'warm',
    processingHealthy: true,
    processingError: null,
    ...overrides,
  };
}

test('startup before Start shows the exact opaque paused output', () => {
  const decision = resolveOutput(state({ started: false, ready: false }));
  assert.equal(decision.mode, 'paused');
  assert.equal(decision.title, PAUSED_TITLE);
  assert.equal(decision.title, 'Tracking paused');
  assert.equal(decision.reason, 'startup');
});

test('started but waiting for the first frame stays paused with a starting reason', () => {
  const decision = resolveOutput(state({ ready: false }));
  assert.equal(decision.mode, 'paused');
  assert.equal(decision.reason, 'starting');
  assert.equal(decision.title, PAUSED_TITLE);
});

test('a ready effect produces a render decision naming the treatment', () => {
  const decision = resolveOutput(state({ effect: 'cool' }));
  assert.equal(decision.mode, 'render');
  assert.match(decision.title, /Cool tint/);
  assert.doesNotMatch(decision.title, /Tracking paused/);
});

test('no active effect hides the output instead of passing the feed through', () => {
  const decision = resolveOutput(state({ effect: 'none' }));
  assert.equal(decision.mode, 'paused');
  assert.equal(decision.reason, 'no-effect');
  assert.equal(decision.title, PAUSED_TITLE);
  assert.equal(decision.action, 'Choose a color treatment to restore the preview.');
});

test('manual pause persists and outranks the no-effect explanation', () => {
  const paused = state({ manualPaused: true, effect: 'none' });
  const decision = resolveOutput(paused);
  assert.equal(decision.mode, 'paused');
  assert.equal(decision.reason, 'manual-pause');
  assert.equal(decision.title, PAUSED_TITLE);
  // Resolving again without resuming yields the same paused decision.
  assert.deepEqual(resolveOutput({ ...paused }), decision);
});

test('a missing fixture produces an actionable paused error', () => {
  const decision = resolveOutput(
    state({
      fixture: {
        state: 'missing',
        metadata: METADATA,
        message: 'Replay fixture media is missing: C:\\fixtures\\cache\\webcam-loop.webm',
        action: 'Run `npm run fetch:fixture`, then press Recheck input.',
      },
    }),
  );
  assert.equal(decision.mode, 'paused');
  assert.equal(decision.reason, 'fixture-missing');
  assert.equal(decision.title, PAUSED_TITLE);
  assert.match(decision.action ?? '', /fetch:fixture/);
});

test('an invalid fixture hides output and explains the checksum failure', () => {
  const decision = resolveOutput(
    state({
      fixture: {
        state: 'invalid',
        metadata: METADATA,
        message: 'Fixture checksum mismatch: expected aaaaaaaaaaaa, found bbbbbbbbbbbb.',
        action: 'Delete the cached clip and run `npm run fetch:fixture`.',
      },
    }),
  );
  assert.equal(decision.mode, 'paused');
  assert.equal(decision.reason, 'fixture-invalid');
  assert.match(decision.explanation, /checksum mismatch/);
});

test('effect-processing failure hides output and recovers only when healthy', () => {
  const failed = state({ processingHealthy: false, processingError: 'simulated failure' });
  assert.equal(resolveOutput(failed).mode, 'paused');
  assert.equal(resolveOutput(failed).reason, 'processing-failure');
  assert.equal(resolveOutput({ ...failed, processingHealthy: true, processingError: null }).mode, 'render');
});

test('a paused screen is never returned as a render decision', () => {
  const pausedStates: PreviewState[] = [
    state({ started: false }),
    state({ ready: false }),
    state({ manualPaused: true }),
    state({ effect: 'none' }),
    state({ processingHealthy: false }),
    state({ fixture: { state: 'missing', metadata: METADATA, message: 'missing' } }),
    state({ fixture: { state: 'invalid', metadata: METADATA, message: 'invalid' } }),
  ];
  for (const pausedState of pausedStates) {
    const decision = resolveOutput(pausedState);
    assert.equal(decision.mode, 'paused');
    assert.equal(decision.title, 'Tracking paused');
    assert.equal(decision.action === undefined, false);
  }
});
