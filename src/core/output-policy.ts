import type { FixtureInfo } from './bridge';
import { getEffectLabel, type EffectId } from './treatments';

export type { EffectId };

/** Exact text required by docs/adr/0003-conceal-the-face-on-tracking-failure.md. */
export const PAUSED_TITLE = 'Tracking paused';

export interface PreviewState {
  fixture: FixtureInfo;
  /** The operator has pressed Start at least once for the current input. */
  started: boolean;
  /** At least one valid replay frame was processed. */
  ready: boolean;
  /** Manual pause persists until the operator resumes. */
  manualPaused: boolean;
  effect: EffectId;
  /** False while effect processing is failing; later slices wire tracking into this. */
  processingHealthy: boolean;
  processingError: string | null;
}

export type PauseReason =
  | 'startup'
  | 'starting'
  | 'fixture-missing'
  | 'fixture-invalid'
  | 'no-effect'
  | 'manual-pause'
  | 'processing-failure';

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
 * The single output policy for the preview and, in later slices, the virtual
 * webcam. There is deliberately no passthrough mode: every failure or
 * non-active state resolves to the opaque paused output.
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
      'Choose a color treatment to restore the preview.',
    );
  }
  if (!state.ready) {
    return paused('starting', 'Waiting for the first valid replay frame.', null);
  }
  return {
    mode: 'render',
    reason: 'ready',
    title: `Effect active: ${getEffectLabel(state.effect)}`,
    explanation: `Processing the replay input with the ${getEffectLabel(state.effect).toLowerCase()} color treatment.`,
    action: null,
  };
}
