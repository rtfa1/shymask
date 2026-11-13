/**
 * Tracking readiness and loss policy for the single-person prototype.
 *
 * The model's own detection/tracking confidence thresholds decide whether a
 * face exists at all; this state machine consumes one sample per processed
 * replay frame and adds the app-level hysteresis that the output policy needs:
 *
 * - `initializing` until the first reliable one-face sample (tracker readiness);
 * - a short grace window so one dropped detection at a loop seam does not flash
 *   the opaque paused screen;
 * - `multiple-faces` and `unreliable` pause immediately or after a short
 *   confirmation window;
 * - recovery requires a confirmed stretch of reliable one-face samples, so the
 *   output cannot flap between processed frames and the paused screen;
 * - the per-sample pose-jump guard only applies while tracking is continuous:
 *   once the phase leaves `tracking`, the pre-loss pose is no longer a valid
 *   reference for a person who may have moved legitimately.
 *
 * Manual pause is deliberately *not* modelled here: the output policy checks it
 * before tracking state, so automatic recovery can never override it.
 */

export interface TrackingPose {
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
  tx: number;
  ty: number;
  tz: number;
}

/** One observation from the face tracker for one replay frame. */
export interface TrackingSample {
  /** Number of faces the tracker reported for this frame. */
  faceCount: number;
  /** Landmark count of the first face (the model reports 478 when healthy). */
  landmarkCount: number;
  /** True when a facial transformation matrix was returned. */
  hasTransform: boolean;
  /** First face bounding-box width as a fraction of the frame width. */
  faceWidthRatio: number;
  /** Rigid pose extracted from the transformation matrix, when available. */
  pose: TrackingPose | null;
}

export type TrackingPhase = 'initializing' | 'tracking' | 'lost' | 'multiple-faces' | 'unreliable';

export interface TrackingSnapshot {
  phase: TrackingPhase;
  /** Raw face count from the latest sample. */
  faceCount: number;
  landmarkCount: number;
  hasTransform: boolean;
  /** True when the sample came from the diagnostic injection control. */
  injected: boolean;
  /** Wall-clock time the current phase began. */
  phaseSinceMs: number;
  /** Time of the last reliable one-face sample, if any. */
  lastGoodAtMs: number | null;
  /** Time since the last reliable one-face sample, if any. */
  sinceGoodMs: number | null;
}

/**
 * Thresholds. The confidence values are passed to the MediaPipe Face Landmarker
 * (0.5 is the model default); the time windows are Shymask hysteresis and are
 * recorded in docs/notes/0003-face-tracking-and-mask.md with the observed
 * frame pacing that motivated them.
 */
export const TRACKING_LIMITS = {
  /** MediaPipe Face Landmarker minimum face-detection confidence. */
  minFaceDetectionConfidence: 0.5,
  /** MediaPipe Face Landmarker minimum face-presence confidence. */
  minFacePresenceConfidence: 0.5,
  /** MediaPipe Face Landmarker minimum tracking confidence. */
  minTrackingConfidence: 0.5,
  /** A detected face with fewer landmarks than this is not trusted. */
  landmarkCount: 400,
  /** Plausible face bounding-box width range (fraction of the frame width). */
  minFaceWidthRatio: 0.04,
  maxFaceWidthRatio: 0.95,
  /** Maximum plausible per-sample pose jump (a detector glitch guard). */
  maxPoseJumpCm: 30,
  maxPoseJumpDeg: 60,
  /**
   * Zero or unreliable detections are tolerated this long before the output is
   * hidden. Above one ~24 Hz frame interval, below the 250 ms decode-gap limit.
   */
  lostGraceMs: 250,
  /** A face that is present but implausible pauses after this window. */
  unreliableConfirmMs: 250,
  /** One reliable face must persist this long before output is restored. */
  recoveryConfirmMs: 300,
  /** Consecutive inference exceptions treated as a persistent processing error. */
  maxConsecutiveInferenceErrors: 5,
} as const;

type Classification = 'reliable' | 'unreliable' | 'none' | 'multiple';

function finitePose(pose: TrackingPose | null): pose is TrackingPose {
  if (!pose) return false;
  return (
    Number.isFinite(pose.yawDeg) &&
    Number.isFinite(pose.pitchDeg) &&
    Number.isFinite(pose.rollDeg) &&
    Number.isFinite(pose.tx) &&
    Number.isFinite(pose.ty) &&
    Number.isFinite(pose.tz)
  );
}

function poseJumpExceeded(previous: TrackingPose, next: TrackingPose): boolean {
  const distance = Math.hypot(next.tx - previous.tx, next.ty - previous.ty, next.tz - previous.tz);
  if (distance > TRACKING_LIMITS.maxPoseJumpCm) return true;
  return (
    Math.abs(next.yawDeg - previous.yawDeg) > TRACKING_LIMITS.maxPoseJumpDeg ||
    Math.abs(next.pitchDeg - previous.pitchDeg) > TRACKING_LIMITS.maxPoseJumpDeg ||
    Math.abs(next.rollDeg - previous.rollDeg) > TRACKING_LIMITS.maxPoseJumpDeg
  );
}

export class TrackingStateMachine {
  private phase: TrackingPhase = 'initializing';
  private phaseSinceMs = 0;
  private lastGoodAtMs: number | null = null;
  private recoverySinceMs: number | null = null;
  private previousPose: TrackingPose | null = null;
  /** First sample of the current continuous zero-face run, if any. */
  private zeroSinceMs: number | null = null;
  private faceCount = 0;
  private landmarkCount = 0;
  private hasTransform = false;
  private injected = false;

  reset(nowMs: number): void {
    this.phase = 'initializing';
    this.phaseSinceMs = nowMs;
    this.lastGoodAtMs = null;
    this.recoverySinceMs = null;
    this.previousPose = null;
    this.zeroSinceMs = null;
    this.faceCount = 0;
    this.landmarkCount = 0;
    this.hasTransform = false;
    this.injected = false;
  }

  classify(sample: TrackingSample): Classification {
    if (sample.faceCount > 1) return 'multiple';
    if (sample.faceCount === 0) return 'none';
    if (
      sample.landmarkCount < TRACKING_LIMITS.landmarkCount ||
      !sample.hasTransform ||
      !finitePose(sample.pose) ||
      sample.faceWidthRatio < TRACKING_LIMITS.minFaceWidthRatio ||
      sample.faceWidthRatio > TRACKING_LIMITS.maxFaceWidthRatio
    ) {
      return 'unreliable';
    }
    if (this.previousPose && poseJumpExceeded(this.previousPose, sample.pose)) {
      return 'unreliable';
    }
    return 'reliable';
  }

  /**
   * Feeds one sample. `injected` marks samples synthesized by the diagnostic
   * control; the state machine behaves identically so the policy under test is
   * the real policy, but diagnostics and evidence label the source.
   */
  update(sample: TrackingSample, nowMs: number, injected = false): TrackingSnapshot {
    const classification = this.classify(sample);
    this.faceCount = sample.faceCount;
    this.landmarkCount = sample.landmarkCount;
    this.hasTransform = sample.hasTransform;
    this.injected = injected;
    this.zeroSinceMs = classification === 'none' ? (this.zeroSinceMs ?? nowMs) : null;

    if (classification === 'reliable') {
      this.lastGoodAtMs = nowMs;
      this.previousPose = sample.pose;
      if (this.phase === 'tracking') {
        this.recoverySinceMs = null;
      } else {
        // Hold the paused output until one face has been reliably visible for
        // the recovery window, so a flapping detector cannot reveal frames.
        this.recoverySinceMs ??= nowMs;
        if (nowMs - this.recoverySinceMs >= TRACKING_LIMITS.recoveryConfirmMs) {
          this.setPhase('tracking', nowMs);
        }
      }
      return this.snapshot(nowMs);
    }

    this.recoverySinceMs = null;

    if (classification === 'multiple') {
      // A second person must never be published: pause immediately.
      this.setPhase('multiple-faces', nowMs);
      return this.snapshot(nowMs);
    }

    // The grace window is measured from the last reliable one-face sample (or
    // from reset when readiness has never been established), not from the
    // first bad sample, so a long gap cannot extend the tolerated window.
    const referenceMs = this.lastGoodAtMs ?? this.phaseSinceMs;
    const sinceReferenceMs = nowMs - referenceMs;
    if (this.phase === 'tracking') {
      const limit =
        classification === 'unreliable' ? TRACKING_LIMITS.unreliableConfirmMs : TRACKING_LIMITS.lostGraceMs;
      if (sinceReferenceMs > limit) {
        this.setPhase(classification === 'unreliable' ? 'unreliable' : 'lost', nowMs);
      }
    } else if (this.phase === 'initializing' && sinceReferenceMs > TRACKING_LIMITS.lostGraceMs) {
      this.setPhase('lost', nowMs);
    } else if (
      this.phase === 'multiple-faces' &&
      classification === 'none' &&
      this.zeroSinceMs !== null &&
      nowMs - this.zeroSinceMs > TRACKING_LIMITS.lostGraceMs
    ) {
      // The second face left as well. The output is already hidden; once zero
      // faces have persisted through the grace window, report the accurate
      // reason (no face) instead of claiming that more than one is visible.
      this.setPhase('lost', nowMs);
    }
    return this.snapshot(nowMs);
  }

  /** Current state, with counters evaluated against `nowMs`. */
  snapshot(nowMs: number): TrackingSnapshot {
    return {
      phase: this.phase,
      faceCount: this.faceCount,
      landmarkCount: this.landmarkCount,
      hasTransform: this.hasTransform,
      injected: this.injected,
      phaseSinceMs: this.phaseSinceMs,
      lastGoodAtMs: this.lastGoodAtMs,
      sinceGoodMs: this.lastGoodAtMs === null ? null : Math.max(0, nowMs - this.lastGoodAtMs),
    };
  }

  private setPhase(phase: TrackingPhase, nowMs: number): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.phaseSinceMs = nowMs;
    if (phase !== 'tracking') {
      // Leaving `tracking` invalidates the pose-jump reference. The guard exists
      // to reject a single glitched sample during continuous tracking; keeping a
      // pre-loss pose would instead reject a person who legitimately moved while
      // the output was paused, so a face returning at a different pose could
      // never reacquire (AC3 automatic recovery).
      this.previousPose = null;
    }
  }
}

export function initialTrackingSnapshot(nowMs = 0): TrackingSnapshot {
  return {
    phase: 'initializing',
    faceCount: 0,
    landmarkCount: 0,
    hasTransform: false,
    injected: false,
    phaseSinceMs: nowMs,
    lastGoodAtMs: null,
    sinceGoodMs: null,
  };
}

/**
 * Decomposes a MediaPipe facial transformation matrix (column-major, translation
 * in elements 12-14, units are the canonical face model's centimetres) into
 * yaw/pitch/roll in MediaPipe camera space (x right, y down, z forward) and the
 * translation. The rotation order is YXZ, the same decomposition the renderer
 * uses for diagnostics, so observations are comparable across the app.
 *
 * Three.js uses a y-up camera; the mask renderer consumes the matrix directly,
 * so this function is diagnostic/plausibility metadata rather than a scene
 * conversion.
 */
export function poseFromColumnMajorMatrix(data: ArrayLike<number>): TrackingPose | null {
  if (data.length < 16) return null;
  for (let index = 0; index < 16; index += 1) {
    const value = data[index];
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  }
  // Column-major: R[row][col] = data[col * 4 + row].
  const r02 = data[2] as number;
  const r10 = data[1] as number;
  const r11 = data[5] as number;
  const r12 = data[6] as number;
  const r22 = data[10] as number;
  const pitch = Math.asin(Math.max(-1, Math.min(1, -r12)));
  const yaw = Math.atan2(r02, r22);
  const roll = Math.atan2(r10, r11);
  const toDegrees = (radians: number): number => (radians * 180) / Math.PI;
  return {
    yawDeg: toDegrees(yaw),
    pitchDeg: toDegrees(pitch),
    rollDeg: toDegrees(roll),
    tx: data[12] as number,
    ty: data[13] as number,
    tz: data[14] as number,
  };
}
