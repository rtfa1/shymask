import type { FixtureInfo, TrackerInfo, VirtualCameraStatus } from '../core/bridge';
import { DECODE_STALL_THRESHOLD_MS, FrameWatchdog } from '../core/frame-watchdog';
import {
  PAUSED_TITLE,
  resolveOutput,
  type OutputDecision,
  type PreviewState,
} from '../core/output-policy';
import { PreviewPipeline, type FrameStats } from '../core/pipeline';
import { ReplayTimeline, type ReplayFrameTimestamp } from '../core/replay-clock';
import { EFFECT_OPTIONS, getEffectLabel, getTreatment, isMaskEffect, type ColorTreatment, type EffectId } from '../core/treatments';
import {
  initialTrackingSnapshot,
  TrackingStateMachine,
  TRACKING_LIMITS,
  type TrackingSample,
} from '../core/tracking';
import { FaceTracker, type DetectedTracking } from './face-tracker';
import { MaskRenderer, type MaskProjection } from './mask-renderer';

const SIMULATED_FAILURE_MESSAGE =
  'Effect processing is failing (simulated by the diagnostic control). The output is hidden.';
const DECODE_STALL_MESSAGE = `The replay frame could not be decoded for more than ${DECODE_STALL_THRESHOLD_MS} ms. Output is hidden while the decoder recovers.`;
const TRACKER_ACTION =
  'Run `npm run fetch:tracker`, then `npm run build`, and restart Shymask. The output stays hidden; there is no camera fallback.';
const WATCHDOG_POLL_MS = 50;

/** Diagnostic tracking-state injection. `auto` uses the real detector. */
type TrackingInjection = 'auto' | 'lost' | 'multiple' | 'unreliable';

const INJECTION_OPTIONS: ReadonlyArray<{ id: TrackingInjection; label: string }> = [
  { id: 'auto', label: 'Use detected face (normal)' },
  { id: 'lost', label: 'Inject tracking lost (diagnostic)' },
  { id: 'multiple', label: 'Inject multiple faces (diagnostic)' },
  { id: 'unreliable', label: 'Inject unreliable tracking (diagnostic)' },
];

const EMPTY_MASK_PROJECTION: MaskProjection = {
  visible: false,
  originX: 0,
  originY: 0,
  centerX: 0,
  centerY: 0,
  widthPx: 0,
  heightPx: 0,
  pose: null,
  probeX: 0,
  probeY: 0,
  probeColor: null,
};

function mustGet<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element #${id}`);
  return element as T;
}

const canvas = mustGet<HTMLCanvasElement>('output');
const startButton = mustGet<HTMLButtonElement>('start');
const pauseButton = mustGet<HTMLButtonElement>('pause-toggle');
const effectSelect = mustGet<HTMLSelectElement>('effect-select');
const injectionSelect = mustGet<HTMLSelectElement>('tracking-injection');
const recheckButton = mustGet<HTMLButtonElement>('recheck');
const captureButton = mustGet<HTMLButtonElement>('capture');
const failureToggle = mustGet<HTMLInputElement>('simulate-failure');
const captureResult = mustGet<HTMLParagraphElement>('capture-result');
const statusPanel = mustGet<HTMLElement>('status-panel');
const statusTitle = mustGet<HTMLParagraphElement>('status-title');
const statusExplanation = mustGet<HTMLParagraphElement>('status-explanation');
const statusAction = mustGet<HTMLParagraphElement>('status-action');
const vcamPanel = mustGet<HTMLElement>('vcam-panel');
const vcamState = mustGet<HTMLParagraphElement>('vcam-state');
const vcamDetail = mustGet<HTMLParagraphElement>('vcam-detail');
const vcamAction = mustGet<HTMLParagraphElement>('vcam-action');
const vcamRestart = mustGet<HTMLButtonElement>('vcam-restart');

const pipeline = new PreviewPipeline(canvas);
const timeline = new ReplayTimeline();
const watchdog = new FrameWatchdog();
const tracking = new TrackingStateMachine();

const state: PreviewState = {
  fixture: { state: 'checking', metadata: null },
  tracker: {
    state: 'checking',
    metadata: null,
    message: 'Checking the face-tracker model and runtime…',
    action: 'Output returns automatically when the face tracker is ready.',
  },
  started: false,
  ready: false,
  manualPaused: false,
  effect: 'warm',
  processingHealthy: true,
  processingError: null,
  tracking: initialTrackingSnapshot(),
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
let lastPublishedAt = 0;
let publishedFrames = 0;
let latestVirtualCamera: VirtualCameraStatus | null = null;
let cameraClients = 0;

// Face tracking.
let faceTracker: FaceTracker | null = null;
let maskRenderer: MaskRenderer | null = null;
let trackerPreparing = false;
let trackerReady = false;
let trackingInjection: TrackingInjection = 'auto';
let lastDetection: DetectedTracking | null = null;
let lastMaskProjection: MaskProjection = EMPTY_MASK_PROJECTION;
let maskRenderCostMs = 0;
let detectionErrors = 0;
let detectionTimings: number[] = [];
let detectedFrames = 0;
let warmupInferenceMs = 0;
let persistentTrackerError: string | null = null;

// The virtual camera and the preview receive the exact same frames. 30 Hz is
// the camera workload; the replay itself presents at ~21-24 Hz here.
const CAMERA_FRAME_MIN_INTERVAL_MS = 1000 / 30;

// The app always paints the exact paused output first; no frame is ever shown
// before the replay fixture and tracker have been validated and started.
pipeline.renderPausedScreen(PAUSED_TITLE);
publishOutputFrame();
statusTitle.textContent = PAUSED_TITLE;

buildEffectOptions();
buildInjectionOptions();
bindControls();
updateStaticDiagnostics();
void refreshVirtualCamera();
void bootstrap();

// requestVideoFrameCallback cannot fire when the decoder silently stops
// presenting frames, so a real timer is the only watchdog for that stall.
window.setInterval(checkDecodeStall, WATCHDOG_POLL_MS);

// Republish the current output on a slow heartbeat. The canvas is always either
// a processed frame or the exact opaque paused screen, so this keeps a newly
// connected camera consumer from receiving a stale frame from before a pause,
// effect switch, or error (the media source caches the newest transported
// frame).
window.setInterval(publishOutputFrame, 100);

async function bootstrap(): Promise<void> {
  if (!window.shymask) {
    fail('The preload bridge is unavailable, so the fixture cannot be checked. Restart the app.');
    return;
  }
  try {
    const info = await window.shymask.getStartupInfo();
    applyTrackerInfo(info.tracker);
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

function buildInjectionOptions(): void {
  for (const option of INJECTION_OPTIONS) {
    const element = document.createElement('option');
    element.value = option.id;
    element.textContent = option.label;
    injectionSelect.appendChild(element);
  }
  injectionSelect.value = trackingInjection;
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
  injectionSelect.addEventListener('change', () => {
    const value = injectionSelect.value;
    const match = INJECTION_OPTIONS.find((option) => option.id === value);
    trackingInjection = (match?.id ?? 'auto') as TrackingInjection;
    // Apply the requested state immediately so the public control is
    // observable without waiting for another replay frame.
    const now = performance.now();
    if (trackingInjection !== 'auto') {
      state.tracking = tracking.update(injectedSample(trackingInjection), now, true);
    } else {
      // Real detection becomes authoritative again on the next replay frame;
      // the normal recovery window keeps the output hidden until then.
      state.tracking = tracking.snapshot(now);
    }
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
  vcamRestart.addEventListener('click', () => {
    if (!window.shymask) return;
    vcamRestart.disabled = true;
    void window.shymask
      .restartVirtualCamera()
      .then((status) => applyVirtualCameraStatus(status))
      .catch((error: Error) => {
        vcamAction.textContent = `Virtual camera restart failed: ${error.message}`;
      })
      .finally(() => {
        vcamRestart.disabled = false;
      });
  });
}

function applyTrackerInfo(info: TrackerInfo): void {
  state.tracker = info;
  if (info.state === 'ready') {
    void initializeTracker(info);
  } else {
    trackerReady = false;
    renderNow();
  }
}

async function initializeTracker(info: TrackerInfo): Promise<void> {
  if (trackerPreparing) return;
  trackerPreparing = true;
  try {
    faceTracker = await FaceTracker.create(info);
    maskRenderer = new MaskRenderer(pipeline.width, pipeline.height);
    trackerReady = true;
    tracking.reset(performance.now());
    state.tracking = tracking.snapshot(performance.now());
    state.tracker = info;
    renderNow();
    updateStaticDiagnostics();
  } catch (error) {
    trackerReady = false;
    faceTracker = null;
    maskRenderer = null;
    state.tracker = {
      state: 'error',
      metadata: info.metadata,
      message: `The face tracker could not start: ${(error as Error).message}`,
      action: `${TRACKER_ACTION} If the problem persists, the machine may not support WebGL2.`,
    };
    renderNow();
  } finally {
    trackerPreparing = false;
  }
}

async function refreshVirtualCamera(): Promise<void> {
  if (!window.shymask) {
    vcamPanel.dataset.state = 'unavailable';
    vcamState.textContent = 'Virtual camera not available';
    vcamAction.textContent = 'The preload bridge is unavailable. Restart the app.';
    return;
  }
  window.shymask.onVirtualCameraStatus(applyVirtualCameraStatus);
  try {
    applyVirtualCameraStatus(await window.shymask.getVirtualCameraStatus());
  } catch (error) {
    vcamPanel.dataset.state = 'error';
    vcamState.textContent = 'Virtual camera unavailable';
    vcamAction.textContent = `Could not read the camera status: ${(error as Error).message}`;
  }
}

function applyVirtualCameraStatus(status: VirtualCameraStatus): void {
  latestVirtualCamera = status;
  cameraClients = status.clients;
  vcamPanel.dataset.state = status.state;
  const titles: Record<VirtualCameraStatus['state'], string> = {
    starting: 'Starting virtual camera…',
    publishing: 'Shymask Camera is available',
    stopped: 'Camera output stopped',
    error: 'Virtual camera unavailable',
    unavailable: 'Virtual camera not installed',
  };
  vcamState.textContent = titles[status.state];
  const details = [status.message];
  if (status.state === 'publishing') {
    details.push(
      `Friendly name: ${status.friendlyName}. Camera clients: ${status.clients}. Output frames sent: ${status.framesPublished}.`,
    );
  }
  vcamDetail.textContent = details.filter(Boolean).join(' ');
  vcamAction.textContent = status.action ?? '';
  vcamRestart.disabled = status.state === 'starting';
  updateVirtualCameraDiagnostics();
}

function updateVirtualCameraDiagnostics(): void {
  if (!latestVirtualCamera) {
    setDiag('diag-vcam', 'state=starting');
    return;
  }
  setDiag(
    'diag-vcam',
    `state=${latestVirtualCamera.state} enumerable=${latestVirtualCamera.enumerable} clients=${latestVirtualCamera.clients} frames=${latestVirtualCamera.framesPublished} port=${latestVirtualCamera.port ?? 'none'} pid=${latestVirtualCamera.hostPid ?? 'none'} published=${publishedFrames}`,
  );
}

/**
 * Hands the current output canvas to the virtual camera transport. Called after
 * every drawn output frame, so processed frames and the opaque paused screen
 * both reach camera consumers through the same output policy.
 */
function publishOutputFrame(): void {
  if (!window.shymask?.publishCameraFrame) return;
  // Only read the canvas back when a camera client is actually consuming
  // frames; an idle virtual camera must not cost preview render time.
  if (cameraClients <= 0) return;
  const now = performance.now();
  if (now - lastPublishedAt < CAMERA_FRAME_MIN_INTERVAL_MS) return;
  lastPublishedAt = now;
  try {
    const data = pipeline.readOutputRgba();
    window.shymask.publishCameraFrame({
      captureUnixMs: Date.now(),
      width: pipeline.width,
      height: pipeline.height,
      data,
    });
    publishedFrames += 1;
  } catch {
    // A canvas readback failure must not affect the preview.
  }
}

function updateStaticDiagnostics(): void {
  setDiag('diag-input', 'replay fixture (no physical camera is opened)');
  setDiag('diag-output', `canvas ${pipeline.width}x${pipeline.height} (single output frame path)`);
  if (state.tracker.metadata) {
    setDiag(
      'diag-model',
      `${state.tracker.metadata.id} sha256=${state.tracker.metadata.sha256.slice(0, 12)}… license=${state.tracker.metadata.license} state=${state.tracker.state}`,
    );
  } else {
    setDiag('diag-model', `state=${state.tracker.state}`);
  }
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
  trackingInjection = 'auto';
  injectionSelect.value = 'auto';
  tracking.reset(performance.now());
  state.tracking = tracking.snapshot(performance.now());
  lastDetection = null;
  lastMaskProjection = EMPTY_MASK_PROJECTION;
  detectionErrors = 0;
  detectionTimings = [];
  detectedFrames = 0;
  warmupInferenceMs = 0;
  persistentTrackerError = null;
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
        action: 'Delete the cached clip and re-run the documented fetch command, then press Recheck input.',
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
  if (!video || state.fixture.state !== 'ready' || !trackerReady) {
    renderNow();
    return;
  }
  state.started = true;
  state.ready = false;
  state.manualPaused = false;
  state.processingHealthy = !failureSimulated;
  state.processingError = failureSimulated ? SIMULATED_FAILURE_MESSAGE : null;
  tracking.reset(performance.now());
  state.tracking = tracking.snapshot(performance.now());
  lastMaskProjection = EMPTY_MASK_PROJECTION;
  detectionErrors = 0;
  detectionTimings = [];
  detectedFrames = 0;
  warmupInferenceMs = 0;
  persistentTrackerError = null;
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
    // A persistent tracker failure must not be cleared by the next frame's
    // timestamp check; only a successful inference does that.
    if (persistentTrackerError === null) {
      state.processingHealthy = true;
      state.processingError = null;
    }
    if (!state.ready && persistentTrackerError === null) state.ready = true;
  }

  updateTracking(element, now);
  const decision = resolveOutput(state);

  if (decision.mode === 'render') {
    if (isMaskEffect(state.effect)) {
      if (element.readyState >= 2 && drawProcessedFrame(element, null)) {
        undrawableSinceMs = null;
        applyDecision(decision);
        maybeUpdateDiagnostics(now);
        return;
      }
      // Tracking says the mask is ready but the pose is not drawable yet. Show
      // the paused screen rather than the raw frame; the next frame resolves it.
      undrawableSinceMs ??= now;
      if (now - undrawableSinceMs <= 250) {
        applyDecision(decision);
        maybeUpdateDiagnostics(now);
        return;
      }
      state.processingHealthy = false;
      state.ready = false;
      state.processingError = 'The face pose was not drawable for more than 250 ms. Output is hidden.';
    } else {
      const treatment = getTreatment(state.effect);
      if (element.readyState >= 2 && drawProcessedFrame(element, treatment)) {
        undrawableSinceMs = null;
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
  }

  const pausedDecision = resolveOutput(state);
  const stats = pipeline.renderPausedScreen(PAUSED_TITLE);
  publishOutputFrame();
  latestStats = stats;
  renderCosts = pushRolling(renderCosts, stats.renderCostMs);
  applyDecision(pausedDecision);
  maybeUpdateDiagnostics(now);
}

/**
 * Runs one tracker sample for the current frame (or the diagnostic injection)
 * and updates the portable tracking state machine. The real detector is always
 * authoritative when the injection control is on `auto`; injection is clearly
 * labelled in the diagnostics and evidence.
 */
function updateTracking(element: HTMLVideoElement, nowMs: number): void {
  if (!state.started || state.manualPaused || state.tracker.state !== 'ready' || !trackerReady) {
    state.tracking = tracking.snapshot(nowMs);
    return;
  }

  let sample: TrackingSample;
  if (trackingInjection !== 'auto') {
    sample = injectedSample(trackingInjection);
    state.tracking = tracking.update(sample, nowMs, true);
    return;
  }

  if (!faceTracker) {
    state.tracking = tracking.snapshot(nowMs);
    return;
  }
  try {
    const startedAt = performance.now();
    const detected = faceTracker.detect(element, Math.max(1, Math.round(startedAt)));
    const inferenceMs = performance.now() - startedAt;
    if (detectedFrames === 0) {
      // The first inference pays WASM/GPU warm-up (about 2 s here); keep it out
      // of the steady-state p95 so timing evidence is not misleading.
      warmupInferenceMs = inferenceMs;
    } else {
      detectionTimings = pushRolling(detectionTimings, inferenceMs);
    }
    detectedFrames += 1;
    detectionErrors = 0;
    if (persistentTrackerError !== null) {
      persistentTrackerError = null;
      if (!failureSimulated) {
        state.processingHealthy = true;
        state.processingError = null;
      }
    }
    lastDetection = detected;
    sample = detected;
    if (detected.matrix && maskRenderer) {
      lastMaskProjection = maskRenderer.setPose(detected.matrix);
    }
    state.tracking = tracking.update(sample, nowMs, false);
  } catch (error) {
    detectionErrors += 1;
    const message = (error as Error).message;
    if (detectionErrors >= TRACKING_LIMITS.maxConsecutiveInferenceErrors) {
      persistentTrackerError = `Face tracking failed repeatedly (${message}). The output is hidden while tracking is unavailable.`;
      state.processingHealthy = false;
      state.processingError = persistentTrackerError;
      state.ready = false;
    }
    sample = {
      faceCount: 1,
      landmarkCount: 0,
      hasTransform: false,
      faceWidthRatio: 0,
      pose: null,
    };
    state.tracking = tracking.update(sample, nowMs, false);
  }
}

function injectedSample(injection: Exclude<TrackingInjection, 'auto'>): TrackingSample {
  switch (injection) {
    case 'lost':
      return { faceCount: 0, landmarkCount: 0, hasTransform: false, faceWidthRatio: 0, pose: null };
    case 'multiple':
      return {
        faceCount: 2,
        landmarkCount: 478,
        hasTransform: true,
        faceWidthRatio: 0.2,
        pose: { yawDeg: 0, pitchDeg: 0, rollDeg: 0, tx: 0, ty: 0, tz: -56 },
      };
    case 'unreliable':
      return { faceCount: 1, landmarkCount: 120, hasTransform: false, faceWidthRatio: 0.2, pose: null };
  }
}

/**
 * Draws one processed frame with the active effect into the single output
 * canvas and publishes it. The frame loop and the on-demand render path share
 * this so both apply exactly the same mask/colour logic and cost accounting.
 * Returns false when the effect cannot be drawn (no drawable mask pose, or no
 * colour treatment), in which case the caller keeps the previous output instead
 * of substituting the raw frame.
 */
function drawProcessedFrame(element: HTMLVideoElement, treatment: ColorTreatment | null): boolean {
  if (isMaskEffect(state.effect)) {
    if (!maskRenderer || !lastMaskProjection.visible) return false;
    maskRenderCostMs = maskRenderer.render();
    latestStats = pipeline.renderProcessedFrame(element, null, maskRenderer.canvas);
    renderCosts = pushRolling(renderCosts, latestStats.renderCostMs + maskRenderCostMs);
  } else {
    if (!treatment) return false;
    latestStats = pipeline.renderProcessedFrame(element, treatment, null);
    renderCosts = pushRolling(renderCosts, latestStats.renderCostMs);
  }
  publishOutputFrame();
  return true;
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
  const now = performance.now();
  state.tracking = tracking.snapshot(now);
  const decision = resolveOutput(state);
  const treatment = getTreatment(state.effect);

  if (decision.mode === 'render' && video && video.readyState >= 2) {
    if (isMaskEffect(state.effect)) {
      if (drawProcessedFrame(video, null)) undrawableSinceMs = null;
      // Without a drawable pose the previous output stays until the next frame;
      // the paused screen is never replaced by the raw frame.
    } else if (treatment && drawProcessedFrame(video, treatment)) {
      undrawableSinceMs = null;
    }
  } else if (decision.mode === 'paused') {
    latestStats = pipeline.renderPausedScreen(PAUSED_TITLE);
    publishOutputFrame();
  }
  // In render mode without a drawable frame, leave the previous processed
  // frame visible rather than substituting the paused screen for one frame.
  applyDecision(decision);
  updateDiagnostics(now);
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
  startButton.disabled = !fixtureReady || state.started || !trackerReady;
  pauseButton.disabled = !state.started;
  pauseButton.textContent = state.manualPaused ? 'Resume' : 'Pause';
  captureButton.disabled = captureInFlight;
  effectSelect.disabled = false;
  injectionSelect.disabled = !trackerReady;
  recheckButton.disabled = false;
}

function maybeUpdateDiagnostics(now: number): void {
  if (now - lastDiagnosticsAt < 200) return;
  lastDiagnosticsAt = now;
  updateDiagnostics(now);
}

function updateDiagnostics(now: number): void {
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

  updateTrackingDiagnostics();
  if (latestStats) setDiag('diag-mask-probe', formatMaskProbe());

  if (currentDecision) {
    setDiag(
      'diag-output',
      `mode=${currentDecision.mode} reason=${currentDecision.reason} canvas=${pipeline.width}x${pipeline.height} effect=${state.effect}`,
    );
  }
  updateVirtualCameraDiagnostics();
  // Tracker readiness and fixture changes arrive asynchronously; keep the
  // Start/Pause/effect controls in sync with the latest state every tick.
  updateControls();
}

function updateTrackingDiagnostics(): void {
  const snapshot = state.tracking;
  setDiag(
    'diag-tracking',
    `phase=${snapshot.phase} faces=${snapshot.faceCount} landmarks=${snapshot.landmarkCount} transform=${snapshot.hasTransform} injected=${snapshot.injected} source=${snapshot.injected ? trackingInjection : 'detector'} sinceGoodMs=${snapshot.sinceGoodMs === null ? 'none' : Math.round(snapshot.sinceGoodMs)} graceMs=${TRACKING_LIMITS.lostGraceMs} recoveryMs=${TRACKING_LIMITS.recoveryConfirmMs} detectionConfidence=${TRACKING_LIMITS.minFaceDetectionConfidence} presenceConfidence=${TRACKING_LIMITS.minFacePresenceConfidence} trackingConfidence=${TRACKING_LIMITS.minTrackingConfidence}`,
  );
  const lastInference = detectionTimings.length > 0 ? detectionTimings[detectionTimings.length - 1] ?? 0 : 0;
  setDiag(
    'diag-tracking-timing',
    `lastMs=${lastInference.toFixed(2)} p95Ms=${percentile95(detectionTimings).toFixed(2)} warmupMs=${warmupInferenceMs.toFixed(1)} frames=${detectedFrames} errors=${detectionErrors}`,
  );
  const face = lastDetection;
  if (face?.faceBbox) {
    const bbox = face.faceBbox;
    setDiag(
      'diag-face',
      `count=${face.faceCount} landmarks=${face.landmarkCount} x=${Math.round(bbox.x * pipeline.width)} y=${Math.round(bbox.y * pipeline.height)} w=${Math.round(bbox.width * pipeline.width)} h=${Math.round(bbox.height * pipeline.height)}`,
    );
  } else {
    setDiag('diag-face', 'count=0 landmarks=0');
  }

  const projection = lastMaskProjection;
  if (projection.visible && projection.pose) {
    setDiag(
      'diag-mask',
      `visible=true originX=${Math.round(projection.originX)} originY=${Math.round(projection.originY)} centerX=${Math.round(projection.centerX)} centerY=${Math.round(projection.centerY)} widthPx=${Math.round(projection.widthPx)} heightPx=${Math.round(projection.heightPx)} yaw=${projection.pose.yawDeg.toFixed(1)} pitch=${projection.pose.pitchDeg.toFixed(1)} roll=${projection.pose.rollDeg.toFixed(1)} tx=${projection.pose.tx.toFixed(1)} ty=${projection.pose.ty.toFixed(1)} tz=${projection.pose.tz.toFixed(1)} probeX=${Math.round(projection.probeX)} probeY=${Math.round(projection.probeY)} renderMs=${maskRenderCostMs.toFixed(2)}`,
    );
    setDiag(
      'diag-mask-color',
      projection.probeColor
        ? `r=${projection.probeColor.r} g=${projection.probeColor.g} b=${projection.probeColor.b}`
        : 'r=0 g=0 b=0',
    );
  } else {
    setDiag('diag-mask', 'visible=false');
    setDiag('diag-mask-color', 'r=0 g=0 b=0');
  }
  if (state.tracker.metadata) {
    setDiag(
      'diag-model',
      `${state.tracker.metadata.id} sha256=${state.tracker.metadata.sha256.slice(0, 12)}… license=${state.tracker.metadata.license} state=${state.tracker.state}`,
    );
  }
}

/** Output-canvas pixel at the mask's eye probe, for public evidence checks. */
function formatMaskProbe(): string {
  if (!lastMaskProjection.visible) return 'r=0 g=0 b=0 x=0 y=0';
  const pixel = pipeline.readPixel(lastMaskProjection.probeX, lastMaskProjection.probeY);
  return pixel
    ? `r=${pixel.r} g=${pixel.g} b=${pixel.b} x=${Math.round(lastMaskProjection.probeX)} y=${Math.round(lastMaskProjection.probeY)}`
    : 'r=0 g=0 b=0 x=0 y=0';
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
