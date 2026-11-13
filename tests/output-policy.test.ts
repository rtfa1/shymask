import assert from 'node:assert/strict';
import test from 'node:test';
import type { FixtureInfo, FixtureMetadata, TrackerInfo } from '../src/core/bridge';
import { PAUSED_TITLE, resolveOutput, type PreviewState } from '../src/core/output-policy';
import { initialTrackingSnapshot, type TrackingSnapshot } from '../src/core/tracking';

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
  videoUrl: 'shymask://app/fixture/webcam-loop.webm',
};

const READY_TRACKER: TrackerInfo = {
  state: 'ready',
  metadata: {
    id: 'mediapipe-face-landmarker-float16-v1',
    version: 'test',
    fileName: 'face_landmarker.task',
    sourceUrl: 'https://example.invalid/model.task',
    license: 'Apache-2.0',
    licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
    attribution: 'Test',
    sha256: 'b'.repeat(64),
    bytes: 100,
    notes: 'test',
  },
  wasmBaseUrl: 'shymask://app/tracker',
  modelUrl: 'shymask://app/tracker/face_landmarker.task',
};

function tracking(overrides: Partial<TrackingSnapshot> = {}): TrackingSnapshot {
  return { ...initialTrackingSnapshot(0), phase: 'tracking', lastGoodAtMs: 100, ...overrides };
}

function state(overrides: Partial<PreviewState> = {}): PreviewState {
  return {
    fixture: READY_FIXTURE,
    tracker: READY_TRACKER,
    started: true,
    ready: true,
    manualPaused: false,
    effect: 'warm',
    processingHealthy: true,
    processingError: null,
    tracking: tracking(),
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

test('a ready effect produces a render decision naming the effect', () => {
  const decision = resolveOutput(state({ effect: 'cool' }));
  assert.equal(decision.mode, 'render');
  assert.match(decision.title, /Cool tint/);
  assert.doesNotMatch(decision.title, /Tracking paused/);
});

test('the rigid mask is a selectable effect with face-attachment wording', () => {
  const decision = resolveOutput(state({ effect: 'mask' }));
  assert.equal(decision.mode, 'render');
  assert.match(decision.title, /Rigid mask/);
  assert.match(decision.explanation, /tracked face/);
});

test('no active effect hides the output instead of passing the feed through', () => {
  const decision = resolveOutput(state({ effect: 'none' }));
  assert.equal(decision.mode, 'paused');
  assert.equal(decision.reason, 'no-effect');
  assert.equal(decision.title, PAUSED_TITLE);
  assert.equal(decision.action, 'Choose an effect to restore the preview.');
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

test('manual pause outranks automatic tracking recovery', () => {
  // Tracking is healthy again, but the operator paused manually: the output
  // must stay hidden until Resume.
  const decision = resolveOutput(
    state({ manualPaused: true, effect: 'mask', tracking: tracking({ phase: 'tracking' }) }),
  );
  assert.equal(decision.mode, 'paused');
  assert.equal(decision.reason, 'manual-pause');
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

test('a missing or corrupt tracker model hides output with an actionable error', () => {
  for (const trackerState of ['missing', 'invalid'] as const) {
    const decision = resolveOutput(
      state({
        tracker: {
          state: trackerState,
          metadata: null,
          message: 'The face-tracker model is missing or corrupt.',
          action: 'Run `npm run fetch:tracker`, then `npm run build`.',
        },
      }),
    );
    assert.equal(decision.mode, 'paused');
    assert.equal(decision.reason, 'tracker-unavailable');
    assert.equal(decision.title, PAUSED_TITLE);
    assert.match(decision.action ?? '', /fetch:tracker/);
  }
});

test('tracking readiness before the first detection pauses every selected effect', () => {
  for (const effect of ['warm', 'cool', 'mono', 'mask'] as const) {
    const decision = resolveOutput(state({ effect, tracking: initialTrackingSnapshot(0) }));
    assert.equal(decision.mode, 'paused');
    assert.equal(decision.reason, 'tracking-initializing');
    assert.equal(decision.title, PAUSED_TITLE);
  }
});

test('tracking loss pauses the existing color treatments as well as the mask', () => {
  for (const effect of ['warm', 'cool', 'mono', 'mask'] as const) {
    const decision = resolveOutput(state({ effect, tracking: tracking({ phase: 'lost', faceCount: 0 }) }));
    assert.equal(decision.mode, 'paused');
    assert.equal(decision.reason, 'tracking-lost');
    assert.match(decision.explanation, /no face/i);
  }
});

test('multiple faces pause the output and explain the one-person limit', () => {
  const decision = resolveOutput(
    state({ effect: 'mask', tracking: tracking({ phase: 'multiple-faces', faceCount: 2 }) }),
  );
  assert.equal(decision.mode, 'paused');
  assert.equal(decision.reason, 'multiple-faces');
  assert.match(decision.explanation, /one person at a time/i);
  assert.match(decision.action ?? '', /automatically/i);
});

test('unreliable tracking pauses the output', () => {
  const decision = resolveOutput(
    state({ tracking: tracking({ phase: 'unreliable', faceCount: 1, hasTransform: false }) }),
  );
  assert.equal(decision.mode, 'paused');
  assert.equal(decision.reason, 'tracking-unreliable');
  assert.equal(decision.title, PAUSED_TITLE);
});

test('a tracking pause never renders even when the effect and frame are ready', () => {
  const phases = ['initializing', 'lost', 'multiple-faces', 'unreliable'] as const;
  for (const phase of phases) {
    for (const effect of ['warm', 'mask'] as const) {
      const decision = resolveOutput(state({ effect, tracking: tracking({ phase }) }));
      assert.equal(decision.mode, 'paused');
      assert.equal(decision.title, 'Tracking paused');
      assert.notEqual(decision.action, undefined);
    }
  }
});

test('an async effect switch keeps the opaque paused output until the new effect is ready', () => {
  const decision = resolveOutput(
    state({ effect: 'package:studio.guard-visor', effectLabel: 'Guard visor', switching: true }),
  );
  assert.equal(decision.mode, 'paused');
  assert.equal(decision.reason, 'effect-switching');
  assert.equal(decision.title, PAUSED_TITLE);
  assert.match(decision.explanation, /Switching to Guard visor/);
  assert.equal(resolveOutput(state({ effectLabel: 'Guard visor', switching: false })).mode, 'render');
});

test('manual pause persists while a package switch is in flight', () => {
  const decision = resolveOutput(
    state({ effect: 'package:studio.guard-visor', effectLabel: 'Guard visor', switching: true, manualPaused: true }),
  );
  assert.equal(decision.mode, 'paused');
  assert.equal(decision.reason, 'manual-pause');
});

test('a stale or invalid effect selection hides the output instead of rendering raw frames', () => {
  const decision = resolveOutput(
    state({ effect: 'package:removed.package', effectLabel: 'Removed effect', effectValid: false }),
  );
  assert.equal(decision.mode, 'paused');
  assert.equal(decision.reason, 'effect-invalid');
  assert.equal(decision.title, PAUSED_TITLE);
  assert.match(decision.action ?? '', /Choose another effect/);
});

test('a package load failure keeps the output paused with an explanation and recovers when cleared', () => {
  const failed = state({
    effect: 'package:studio.guard-visor',
    effectLabel: 'Guard visor',
    effectError: 'The imported effect could not be loaded "Guard visor": the local asset request returned HTTP 404.',
  });
  const decision = resolveOutput(failed);
  assert.equal(decision.mode, 'paused');
  assert.equal(decision.reason, 'effect-unavailable');
  assert.match(decision.explanation, /could not be loaded/);
  assert.match(decision.action ?? '', /remove the imported package/);
  assert.equal(resolveOutput({ ...failed, effectError: null }).mode, 'render');
});

test('a complete package effect renders with combined face-attachment and treatment wording', () => {
  const decision = resolveOutput(
    state({
      effect: 'package:studio.guard-visor',
      effectLabel: 'Guard visor',
      effectHasMask: true,
      effectHasTreatment: true,
    }),
  );
  assert.equal(decision.mode, 'render');
  assert.equal(decision.title, 'Effect active: Guard visor');
  assert.match(decision.explanation, /mask attached to the tracked face/);
  assert.match(decision.explanation, /color treatment/);
});
