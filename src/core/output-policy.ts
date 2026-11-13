import type { FixtureInfo, TrackerInfo } from './bridge';
import { getEffectLabel, isMaskEffect, type EffectId } from './treatments';
import type { TrackingSnapshot } from './tracking';

export type { EffectId };

/** Exact text required by docs/adr/0003-conceal-the-face-on-tracking-failure.md. */
export const PAUSED_TITLE = 'Tracking paused';

export interface PreviewState {
  fixture: FixtureInfo;
  /** Face-tracker assets (model + WASM). Validated before the app uses them. */
  tracker: TrackerInfo;
  /** The operator has pressed Start at least once for the current input. */
  started: boolean;
  /** At least one valid replay frame was processed. */
  ready: boolean;
  /** Manual pause persists until the operator resumes. */
  manualPaused: boolean;
  effect: EffectId;
  /** False while effect or tracker processing is failing. */
  processingHealthy: boolean;
  processingError: string | null;
  /** Tracking readiness/loss phase derived from the latest tracker samples. */
  tracking: TrackingSnapshot;
}

export type PauseReason =
  | 'startup'
  | 'starting'
  | 'fixture-missing'
  | 'fixture-invalid'
  | 'tracker-unavailable'
  | 'no-effect'
  | 'manual-pause'
  | 'processing-failure'
  | 'tracking-initializing'
  | 'tracking-lost'
  | 'multiple-faces'
  | 'tracking-unreliable';

export interface PausedDecision {
  mode: 'paused';
  reason: PauseReason;
  title: typeof PAUSED_TITLE;
  explanation: string;
  action: string | null;
}

export interface RenderDecision {
  mode: 'render';
  reason: 'ready';
  title: string;
  explanation: string;
  action: null;
}

export type OutputDecision = PausedDecision | RenderDecision;

function paused(reason: PauseReason, explanation: string, action: string | null = null): PausedDecision {
  return { mode: 'paused', reason, title: PAUSED_TITLE, explanation, action };
}

/**
 * The single output policy for the preview and the virtual webcam. There is
 * deliberately no passthrough mode: every failure, non-active state or tracking
 * failure resolves to the opaque paused output. Tracking readiness/loss gates
 * every selected effect, including the color treatments (issue #4, AC4).
 */
export function resolveOutput(state: PreviewState): OutputDecision {
  if (state.fixture.state === 'missing') {
    return paused(
      'fixture-missing',
      state.fixture.message ?? 'The recorded replay fixture is missing.',
      state.fixture.action ?? 'Run `npm run fetch:fixture`, then press Recheck input.',
    );
  }
  if (state.fixture.state === 'invalid') {
    return paused(
      'fixture-invalid',
      state.fixture.message ?? 'The recorded replay fixture is invalid.',
      state.fixture.action ?? 'Run `npm run fetch:fixture`, then press Recheck input.',
    );
  }
  if (state.tracker.state !== 'ready') {
    return paused(
      'tracker-unavailable',
      state.tracker.message ?? 'The face tracker is not available, so the output is hidden.',
      state.tracker.action ?? 'Run `npm run fetch:tracker`, then restart the app.',
    );
  }
  if (!state.processingHealthy) {
    return paused(
      'processing-failure',
      state.processingError ?? 'Effect processing is unavailable, so the output is hidden.',
      'Output returns automatically when processing recovers.',
    );
  }
  if (!state.started) {
    return paused(
      'startup',
      'The preview has not started. Press Start to replay the recorded webcam-style clip.',
      null,
    );
  }
  // Manual pause is evaluated before every tracking phase so automatic
  // tracking recovery can never override it.
  if (state.manualPaused) {
    return paused(
      'manual-pause',
      'Preview paused manually. The output stays hidden until you resume.',
      'Press Resume to continue the processed preview.',
    );
  }
  if (state.effect === 'none') {
    return paused(
      'no-effect',
      'No effect is active, so the processed output is hidden.',
      'Choose an effect to restore the preview.',
    );
  }
  const trackingPause = trackingPausedDecision(state.tracking);
  if (trackingPause) return trackingPause;
  if (!state.ready) {
    return paused('starting', 'Waiting for the first valid replay frame.', null);
  }
  if (isMaskEffect(state.effect)) {
    return {
      mode: 'render',
      reason: 'ready',
      title: `Effect active: ${getEffectLabel(state.effect)}`,
      explanation: `Processing the replay input with the ${getEffectLabel(state.effect).toLowerCase()} attached to the tracked face.`,
      action: null,
    };
  }
  return {
    mode: 'render',
    reason: 'ready',
    title: `Effect active: ${getEffectLabel(state.effect)}`,
    explanation: `Processing the replay input with the ${getEffectLabel(state.effect).toLowerCase()} color treatment.`,
    action: null,
  };
}

function trackingPausedDecision(tracking: TrackingSnapshot): PausedDecision | null {
  switch (tracking.phase) {
    case 'tracking':
      return null;
    case 'initializing':
      return paused(
        'tracking-initializing',
        'Face tracking is starting. The output stays hidden until the tracker reports one reliable face.',
        'Output returns automatically as soon as tracking is ready.',
      );
    case 'lost':
      return paused(
        'tracking-lost',
        'Face tracking was lost because no face was detected. The output is hidden instead of showing the raw feed.',
        'Output returns automatically when one face is visible and tracking is healthy again.',
      );
    case 'multiple-faces':
      return paused(
        'multiple-faces',
        'More than one face is visible. Shymask supports one person at a time, so the output is hidden.',
        'Output returns automatically when exactly one face remains.',
      );
    case 'unreliable':
      return paused(
        'tracking-unreliable',
        'Face tracking is unreliable because the detected face or its pose was not trustworthy. The output is hidden.',
        'Output returns automatically when tracking is reliable again.',
      );
  }
}
