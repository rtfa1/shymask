import type { FixtureInfo } from '../core/bridge';
import { DECODE_STALL_THRESHOLD_MS, FrameWatchdog } from '../core/frame-watchdog';
import { PAUSED_TITLE, resolveOutput, type OutputDecision, type PreviewState } from '../core/output-policy';
import { PreviewPipeline, type FrameStats } from '../core/pipeline';
import { ReplayTimeline, type ReplayFrameTimestamp } from '../core/replay-clock';
import { EFFECT_OPTIONS, getTreatment, type EffectId } from '../core/treatments';

const SIMULATED_FAILURE_MESSAGE =
  'Effect processing is failing (simulated by the diagnostic control). The output is hidden.';
const DECODE_STALL_MESSAGE = `The replay frame could not be decoded for more than ${DECODE_STALL_THRESHOLD_MS} ms. Output is hidden while the decoder recovers.`;
const WATCHDOG_POLL_MS = 50;

function mustGet<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element #${id}`);
  return element as T;
}

const canvas = mustGet<HTMLCanvasElement>('output');
const startButton = mustGet<HTMLButtonElement>('start');
const pauseButton = mustGet<HTMLButtonElement>('pause-toggle');
const effectSelect = mustGet<HTMLSelectElement>('effect-select');
const recheckButton = mustGet<HTMLButtonElement>('recheck');
const captureButton = mustGet<HTMLButtonElement>('capture');
const failureToggle = mustGet<HTMLInputElement>('simulate-failure');
const captureResult = mustGet<HTMLParagraphElement>('capture-result');
const statusPanel = mustGet<HTMLElement>('status-panel');
const statusTitle = mustGet<HTMLParagraphElement>('status-title');
const statusExplanation = mustGet<HTMLParagraphElement>('status-explanation');
const statusAction = mustGet<HTMLParagraphElement>('status-action');

const pipeline = new PreviewPipeline(canvas);
const timeline = new ReplayTimeline();
const watchdog = new FrameWatchdog();

const state: PreviewState = {
  fixture: { state: 'checking', metadata: null },
  started: false,
  ready: false,
  manualPaused: false,
  effect: 'warm',
  processingHealthy: true,
  processingError: null,
};

let video: HTMLVideoElement | null = null;
let frameLoopActive = false;
let failureSimulated = false;
let captureInFlight = false;
let currentDecision: OutputDecision | null = null;
let latestTimestamp: ReplayFrameTimestamp | null = null;
let latestStats: FrameStats | null = null;
let frameIntervals: number[] = [];
let renderCosts: number[] = [];
let lastDiagnosticsAt = 0;
let undrawableSinceMs: number | null = null;

// The app always paints the exact paused output first; no frame is ever shown
// before the replay fixture has been validated and started.
pipeline.renderPausedScreen(PAUSED_TITLE);
statusTitle.textContent = PAUSED_TITLE;

buildEffectOptions();
bindControls();
updateStaticDiagnostics();
void bootstrap();

// requestVideoFrameCallback cannot fire when the decoder silently stops
// presenting frames, so a real timer is the only watchdog for that stall.
window.setInterval(checkDecodeStall, WATCHDOG_POLL_MS);

async function bootstrap(): Promise<void> {
  if (!window.shymask) {
    fail('The preload bridge is unavailable, so the fixture cannot be checked. Restart the app.');
    return;
  }
  try {
    const info = await window.shymask.getStartupInfo();
    applyFixture(info.fixture);
  } catch (error) {
    fail(`Startup fixture check failed: ${(error as Error).message}`);
  }
}

function buildEffectOptions(): void {
  for (const option of EFFECT_OPTIONS) {
    const element = document.createElement('option');
    element.value = option.id;
    element.textContent = option.label;
    effectSelect.appendChild(element);
  }
  effectSelect.value = state.effect;
}

function bindControls(): void {
  startButton.addEventListener('click', () => {
    void startPreview();
  });
  pauseButton.addEventListener('click', togglePause);
  effectSelect.addEventListener('change', () => {
    const value = effectSelect.value;
    const match = EFFECT_OPTIONS.find((option) => option.id === value);
    state.effect = (match?.id ?? 'none') as EffectId;
    renderNow();
  });
  recheckButton.addEventListener('click', () => {
    void recheckFixture();
  });
  captureButton.addEventListener('click', () => {
    void captureEvidence();
  });
  failureToggle.addEventListener('change', () => {
    failureSimulated = failureToggle.checked;
    state.processingHealthy = !failureSimulated;
    state.processingError = failureSimulated ? SIMULATED_FAILURE_MESSAGE : null;
    renderNow();
  });
}

function updateStaticDiagnostics(): void {
  setDiag('diag-input', 'replay fixture (no physical camera is opened)');
  setDiag('diag-output', `canvas ${pipeline.width}x${pipeline.height} (single output frame path)`);
}

function applyFixture(fixture: FixtureInfo): void {
  disposeVideo();
  watchdog.disarm();
  state.fixture = fixture;
  state.started = false;
  state.ready = false;
  state.manualPaused = false;
  // Reset the diagnostic-only failure injection before deriving the processing
  // state. A recheck must not leave a stale simulated-failure pause behind.
  failureSimulated = false;
  failureToggle.checked = false;
  state.processingHealthy = true;
  state.processingError = null;
  timeline.reset();
  latestTimestamp = null;
  latestStats = null;
  frameIntervals = [];
  renderCosts = [];
  undrawableSinceMs = null;
  lastDiagnosticsAt = 0;
  captureResult.textContent = '';

  if (fixture.state === 'ready' && fixture.metadata && fixture.videoUrl) {
    const metadata = fixture.metadata;
    setDiag(
      'diag-fixture',
      `${metadata.id} sha256=${metadata.sha256.slice(0, 12)}… bytes=${metadata.bytes} duration=${metadata.durationSeconds}s ${metadata.width}x${metadata.height} license=${metadata.license}`,
    );
    prepareVideo(fixture);
  } else {
    setDiag('diag-fixture', fixture.message ?? `fixture state: ${fixture.state}`);
  }
  renderNow();
}

function prepareVideo(fixture: FixtureInfo): void {
  const element = document.createElement('video');
  element.muted = true;
  element.loop = true;
  element.playsInline = true;
  element.preload = 'auto';
  element.src = fixture.videoUrl ?? '';
  element.style.display = 'none';
  document.body.appendChild(element);
  video = element;

  element.addEventListener('loadedmetadata', () => {
    const expected = fixture.metadata?.durationSeconds;
    if (typeof expected === 'number' && Number.isFinite(element.duration) && Math.abs(element.duration - expected) > 0.5) {
      state.fixture = {
        ...fixture,
        state: 'invalid',
        message: `Decoded replay duration ${element.duration.toFixed(2)}s does not match the documented ${expected.toFixed(2)}s.`,
        action: 'Delete the cached clip and run `npm run fetch:fixture`, then press Recheck input.',
      };
      disposeVideo();
      renderNow();
    }
    updateControls();
  });

  element.addEventListener('error', () => {
    state.processingHealthy = false;
    state.processingError =
      'The replay clip could not be decoded. Re-fetch the fixture and press Recheck input.';
    state.ready = false;
    renderNow();
  });

  element.load();
}

function disposeVideo(): void {
  if (!video) return;
  const element = video;
  video = null;
  frameLoopActive = false;
  watchdog.disarm();
  element.pause();
  element.removeAttribute('src');
  element.load();
  element.remove();
}

async function startPreview(): Promise<void> {
  if (!video || state.fixture.state !== 'ready') {
    renderNow();
    return;
  }
  state.started = true;
  state.ready = false;
  state.manualPaused = false;
  state.processingHealthy = !failureSimulated;
  state.processingError = failureSimulated ? SIMULATED_FAILURE_MESSAGE : null;
  timeline.reset();
  frameIntervals = [];
  renderCosts = [];
  latestTimestamp = null;
  latestStats = null;
  undrawableSinceMs = null;
  lastDiagnosticsAt = 0;
  watchdog.arm(performance.now());
  renderNow();

  try {
    await video.play();
  } catch (error) {
    state.started = false;
    state.processingHealthy = false;
    state.processingError = `Playback did not start: ${(error as Error).message}`;
    watchdog.disarm();
    renderNow();
    return;
  }
  subscribeFrameLoop();
  updateControls();
}

function subscribeFrameLoop(): void {
  if (!video || frameLoopActive) return;
  const element = video;
  frameLoopActive = true;
  const onFrame = (now: number, metadata: VideoFrameCallbackMetadata): void => {
    if (video !== element || !element.isConnected) {
      frameLoopActive = false;
      return;
    }
    watchdog.noteFrame(now);
    processFrame(element, now, metadata);
    element.requestVideoFrameCallback(onFrame);
  };
  element.requestVideoFrameCallback(onFrame);
}

function processFrame(element: HTMLVideoElement, now: number, metadata: VideoFrameCallbackMetadata): void {
  const timestamp = timeline.record({
    mediaTimeSeconds: metadata.mediaTime,
    presentedAtMs: now,
    loopDurationSeconds: element.duration,
  });
  latestTimestamp = timestamp;
  if (timestamp.frameDeltaMs > 0) {
    frameIntervals = pushRolling(frameIntervals, timestamp.frameDeltaMs);
  }

  if (!timestamp.valid) {
    state.processingHealthy = false;
    state.ready = false;
    state.processingError = `Processing timestamps stopped increasing (${timestamp.invalidReason ?? 'invalid timestamp'}). Output is hidden to avoid showing untimed frames.`;
  } else if (!failureSimulated) {
    state.processingHealthy = true;
    state.processingError = null;
    if (!state.ready) state.ready = true;
  }

  const decision = resolveOutput(state);
  const treatment = getTreatment(state.effect);
  if (decision.mode === 'render') {
    if (treatment && element.readyState >= 2) {
      undrawableSinceMs = null;
      const stats = pipeline.renderProcessedFrame(element, treatment);
      latestStats = stats;
      renderCosts = pushRolling(renderCosts, stats.renderCostMs);
      applyDecision(decision);
      maybeUpdateDiagnostics(now);
      return;
    }
    // Chromium can report readyState < 2 for a single presented frame at a
    // loop seam. Keep the last processed frame instead of flashing the paused
    // screen; a prolonged decode gap is a genuine processing failure.
    undrawableSinceMs ??= now;
    if (now - undrawableSinceMs <= 250) {
      applyDecision(decision);
      maybeUpdateDiagnostics(now);
      return;
    }
    state.processingHealthy = false;
    state.ready = false;
    state.processingError = DECODE_STALL_MESSAGE;
  }

  const pausedDecision = resolveOutput(state);
  const stats = pipeline.renderPausedScreen(PAUSED_TITLE);
  latestStats = stats;
  renderCosts = pushRolling(renderCosts, stats.renderCostMs);
  applyDecision(pausedDecision);
  maybeUpdateDiagnostics(now);
}

/**
 * Timer tick for a decoder that stops presenting frames. It only hides output
 * when a frame is genuinely expected (started, not manually paused, a fixture
 * and an effect active) and processing is otherwise healthy, so a specific
 * decode/error message is not overwritten by the generic stall message.
 */
function checkDecodeStall(): void {
  const expectFrame =
    state.started &&
    !state.manualPaused &&
    state.fixture.state === 'ready' &&
    state.effect !== 'none';
  const stalled = watchdog.check(performance.now(), expectFrame);
  if (!stalled || !state.processingHealthy) return;
  state.processingHealthy = false;
  state.ready = false;
  state.processingError = DECODE_STALL_MESSAGE;
  renderNow();
}

function renderNow(): void {
  const decision = resolveOutput(state);
  const treatment = getTreatment(state.effect);
  if (decision.mode === 'render' && treatment && video && video.readyState >= 2) {
    undrawableSinceMs = null;
    latestStats = pipeline.renderProcessedFrame(video, treatment);
  } else if (decision.mode === 'paused') {
    latestStats = pipeline.renderPausedScreen(PAUSED_TITLE);
  }
  // In render mode without a drawable frame, leave the previous processed
  // frame visible rather than substituting the paused screen for one frame.
  applyDecision(decision);
  updateDiagnostics(performance.now());
}

function applyDecision(decision: OutputDecision): void {
  const unchanged =
    currentDecision !== null &&
    currentDecision.mode === decision.mode &&
    currentDecision.reason === decision.reason &&
    currentDecision.title === decision.title &&
    currentDecision.explanation === decision.explanation &&
    (currentDecision.action ?? '') === (decision.action ?? '');
  if (unchanged) return;
  currentDecision = decision;
  statusPanel.dataset.mode = decision.mode;
  document.body.dataset.outputMode = decision.mode;
  statusTitle.textContent = decision.title;
  statusExplanation.textContent = decision.explanation;
  statusAction.textContent = decision.action ?? '';
  updateControls();
}

function togglePause(): void {
  if (!video || !state.started) return;
  if (state.manualPaused) {
    state.manualPaused = false;
    watchdog.arm(performance.now());
    void video.play().catch((error: Error) => {
      state.processingHealthy = false;
      state.processingError = `Playback did not resume: ${error.message}`;
      watchdog.disarm();
      renderNow();
    });
  } else {
    state.manualPaused = true;
    watchdog.disarm();
    video.pause();
  }
  renderNow();
}

async function recheckFixture(): Promise<void> {
  if (!window.shymask) return;
  try {
    const fixture = await window.shymask.recheckFixture();
    applyFixture(fixture);
  } catch (error) {
    fail(`Fixture check failed: ${(error as Error).message}`);
  }
}

async function captureEvidence(): Promise<void> {
  if (captureInFlight) return;
  if (!window.shymask) {
    captureResult.textContent = 'Capture failed: preload bridge unavailable.';
    return;
  }
  captureInFlight = true;
  captureButton.disabled = true;
  try {
    const result = await window.shymask.captureOutputPng(canvas.toDataURL('image/png'));
    captureResult.textContent =
      result.ok && result.path ? `Captured ${result.path}` : `Capture failed: ${result.error ?? 'unknown error'}`;
  } catch (error) {
    captureResult.textContent = `Capture failed: ${(error as Error).message}`;
  } finally {
    captureInFlight = false;
    updateControls();
  }
}

function updateControls(): void {
  const fixtureReady = state.fixture.state === 'ready' && video !== null;
  startButton.disabled = !fixtureReady || state.started;
  pauseButton.disabled = !state.started;
  pauseButton.textContent = state.manualPaused ? 'Resume' : 'Pause';
  captureButton.disabled = captureInFlight;
  effectSelect.disabled = false;
  recheckButton.disabled = false;
}

function maybeUpdateDiagnostics(now: number): void {
  if (now - lastDiagnosticsAt < 200) return;
  lastDiagnosticsAt = now;
  updateDiagnostics(now);
}

function updateDiagnostics(_now: number): void {
  setDiag('diag-loop', `loops=${timeline.loops} seams=${timeline.seams}`);
  if (latestTimestamp) {
    setDiag(
      'diag-timestamp',
      `processingMs=${latestTimestamp.processingTimestampMs.toFixed(1)} mediaMs=${latestTimestamp.mediaTimeMs.toFixed(1)}`,
    );
  } else {
    setDiag('diag-timestamp', 'processingMs=none mediaMs=none');
  }

  const lastInterval = frameIntervals.length > 0 ? frameIntervals[frameIntervals.length - 1] ?? 0 : 0;
  setDiag('diag-frame-delta', `lastMs=${lastInterval.toFixed(1)} p95Ms=${percentile95(frameIntervals).toFixed(1)}`);

  if (latestStats) {
    const lastCost = renderCosts.length > 0 ? renderCosts[renderCosts.length - 1] ?? 0 : 0;
    setDiag('diag-render-cost', `lastMs=${lastCost.toFixed(2)} p95Ms=${percentile95(renderCosts).toFixed(2)}`);
    setDiag('diag-rgb', `r=${latestStats.meanRgb.r} g=${latestStats.meanRgb.g} b=${latestStats.meanRgb.b}`);
  } else {
    setDiag('diag-render-cost', 'lastMs=0.00 p95Ms=0.00');
  }

  if (currentDecision) {
    setDiag(
      'diag-output',
      `mode=${currentDecision.mode} reason=${currentDecision.reason} canvas=${pipeline.width}x${pipeline.height} treatment=${state.effect}`,
    );
  }
}

function pushRolling(values: number[], value: number): number[] {
  const next = values.length >= 180 ? values.slice(values.length - 179) : values.slice();
  next.push(value);
  return next;
}

function percentile95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? 0;
}

function setDiag(id: string, value: string): void {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function fail(message: string): void {
  state.fixture = { state: 'invalid', metadata: null, message, action: 'Restart the app.' };
  renderNow();
}
