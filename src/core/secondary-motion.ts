/**
 * Bounded, deterministic secondary-motion simulation for packaged mask parts.
 *
 * A package may declare a small number of named GLB nodes as movable parts.
 * This module owns the whole runtime behavior: each part is an angular
 * spring-damper driven by one component of the tracked head's angular velocity.
 * There is no canned clip and no package-supplied code: the package supplies
 * only the bounded parameters validated by `effect-package.ts`.
 *
 * Why a velocity-driven spring? It is the smallest model that reacts to real
 * recorded head motion *and keeps moving after the head stops*: while the head
 * turns, the spring target is proportional to the head's angular velocity, so
 * the part lags behind; when the head stops, the target returns to rest and the
 * underdamped spring settles with a decaying oscillation. The response is
 * therefore derived from the accepted tracked pose every processed frame, not
 * replayed.
 *
 * Determinism and bounds:
 * - each frame interval is split into equal sub-steps of at most 1/120 s and
 *   integrated with semi-implicit Euler, so the same accepted-pose sequence
 *   produces the same angles;
 * - `dt` is clamped to `[0.5, maxGapMs]` and a gap longer than `maxGapMs`
 *   deliberately resets to rest instead of integrating a stale dt;
 * - a per-sample pose discontinuity, a non-finite sample, a loop seam, a
 *   tracking reacquisition and an explicit reset all snap to rest and zero the
 *   velocity. None of them injects an impulse;
 * - the angle is hard-clamped to `[-maxAngleDeg, maxAngleDeg]` and an outward
 *   velocity is zeroed at the clamp, so spring overshoot cannot move a part past
 *   its declaration even when the drive saturates.
 *
 * The module has no DOM, WebGL or Three.js dependency, so the bounds, the
 * clamped-dt behavior, the resets and the post-turn settling are unit-tested
 * without the app.
 */

import {
  SECONDARY_MOTION_RUNTIME,
  type SecondaryMotionDrive,
  type SecondaryMotionParameters,
  type SecondaryMotionPart,
} from './effect-package-contract';

export type SecondaryMotionResetReason =
  | 'first'
  | 'gap'
  | 'discontinuity'
  | 'loop-seam'
  | 'reacquisition'
  | 'explicit';

export interface HeadRotationSample {
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
  /** Monotonic time of the accepted sample, milliseconds. */
  timeMs: number;
}

export interface HeadAngularVelocity {
  yaw: number;
  pitch: number;
  roll: number;
}

export interface SecondaryMotionFrame {
  /** Clamped frame interval used by this update, milliseconds. */
  dtMs: number;
  /** Applied part angles in declaration order, degrees. */
  anglesDeg: number[];
  /** Largest absolute angle over all parts, degrees. */
  maxAbsAngleDeg: number;
  /** Head angular velocity used for the drive, degrees/second. */
  headVelocityDegPerSec: HeadAngularVelocity;
  /** Largest absolute head velocity component, degrees/second. */
  headSpeedDegPerSec: number;
  /** True when this frame deliberately reset the spring state. */
  reset: boolean;
  resetReason: SecondaryMotionResetReason | null;
  /** Equal sub-steps of at most 1/120 s integrated this frame (0 on a reset). */
  steps: number;
  /** Cost of this update in milliseconds. */
  costMs: number;
}

export interface SecondaryMotionSnapshot {
  parts: number;
  updates: number;
  resets: number;
  lastResetReason: SecondaryMotionResetReason | null;
  anglesDeg: number[];
  maxAbsAngleDeg: number;
  headSpeedDegPerSec: number;
  steps: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/** Shortest signed rotation from `from` to `to`, in degrees `[-180, 180)`. */
export function shortestAngleDeltaDegrees(from: number, to: number): number {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

function finiteSample(sample: HeadRotationSample): boolean {
  return (
    Number.isFinite(sample.yawDeg) &&
    Number.isFinite(sample.pitchDeg) &&
    Number.isFinite(sample.rollDeg) &&
    Number.isFinite(sample.timeMs)
  );
}

function driveValue(velocity: HeadAngularVelocity, drive: SecondaryMotionDrive): number {
  switch (drive) {
    case 'yaw':
      return velocity.yaw;
    case 'pitch':
      return velocity.pitch;
    case 'roll':
      return velocity.roll;
  }
}

interface PartState {
  readonly part: SecondaryMotionPart;
  /** Applied angle relative to the authored GLB orientation, degrees. */
  angleDeg: number;
  velocityDegPerSec: number;
}

const IDENTITY_VELOCITY: HeadAngularVelocity = { yaw: 0, pitch: 0, roll: 0 };

export class SecondaryMotionSimulator {
  private readonly states: PartState[];
  private initialized = false;
  private lastSample: HeadRotationSample | null = null;
  private pendingReset: SecondaryMotionResetReason | null = null;
  private lastResetReason: SecondaryMotionResetReason | null = null;
  private updateCount = 0;
  private resetCount = 0;
  private totalSteps = 0;
  private lastFrame: SecondaryMotionFrame;

  constructor(readonly parameters: SecondaryMotionParameters) {
    this.states = parameters.parts.map((part) => ({
      part,
      angleDeg: part.restAngleDeg,
      velocityDegPerSec: 0,
    }));
    this.lastFrame = {
      dtMs: 0,
      anglesDeg: this.states.map((state) => state.angleDeg),
      maxAbsAngleDeg: this.maxAbsAngle(),
      headVelocityDegPerSec: { ...IDENTITY_VELOCITY },
      headSpeedDegPerSec: 0,
      reset: true,
      resetReason: 'first',
      steps: 0,
      costMs: 0,
    };
  }

  /**
   * Deliberately drops accumulated spring state. The next update reports the
   * reason and starts from the declared rest pose (the authored GLB orientation
   * plus `restAngleDeg`) with zero velocity, so a reacquisition, a loop seam or
   * an explicit caller reset never injects a synthetic kick.
   */
  reset(reason: SecondaryMotionResetReason = 'explicit'): void {
    this.initialized = false;
    this.lastSample = null;
    this.pendingReset = reason;
    this.lastResetReason = reason;
    this.resetCount += 1;
    this.setRestState();
    this.lastFrame = {
      ...this.lastFrame,
      anglesDeg: this.states.map((state) => state.angleDeg),
      maxAbsAngleDeg: this.maxAbsAngle(),
      reset: true,
      resetReason: reason,
      steps: 0,
    };
  }

  get last(): SecondaryMotionFrame {
    return this.lastFrame;
  }

  /**
   * Re-establishes time continuity at a new sample **without** changing the
   * spring state. Used only by the held-frame settling diagnostic: the accepted
   * tracking pose is stationary while wall-clock time advances, so the next
   * update can integrate from the retained angle with zero head velocity
   * instead of treating the hold as a >250 ms tracking gap.
   */
  resumeAt(sample: HeadRotationSample): void {
    if (!finiteSample(sample)) return;
    this.lastSample = { ...sample };
    this.initialized = true;
  }

  get snapshot(): SecondaryMotionSnapshot {
    return {
      parts: this.states.length,
      updates: this.updateCount,
      resets: this.resetCount,
      lastResetReason: this.lastResetReason,
      anglesDeg: this.states.map((state) => state.angleDeg),
      maxAbsAngleDeg: this.maxAbsAngle(),
      headSpeedDegPerSec: this.lastFrame.headSpeedDegPerSec,
      steps: this.totalSteps,
    };
  }

  /**
   * Integrates one accepted head-pose sample and returns the part angles to
   * render. `sample.timeMs` is the monotonic presented-frame time (same clock
   * as the pose smoother), not the loop-aware media timestamp: a loop seam is
   * reported separately by the caller and resets state before the next sample.
   */
  update(sample: HeadRotationSample): SecondaryMotionFrame {
    const startedAt = performance.now();
    const resetReason = this.pendingReset;
    this.pendingReset = null;

    if (!finiteSample(sample)) {
      this.snapToRest('discontinuity');
      return this.finishFrame(0, { ...IDENTITY_VELOCITY }, true, 'discontinuity', 0, startedAt);
    }

    if (!this.initialized || this.lastSample === null) {
      this.lastSample = { ...sample };
      this.initialized = true;
      this.updateCount += 1;
      return this.finishFrame(
        0,
        { ...IDENTITY_VELOCITY },
        true,
        resetReason ?? 'first',
        0,
        startedAt,
      );
    }

    const rawDt = sample.timeMs - this.lastSample.timeMs;
    if (!Number.isFinite(rawDt) || rawDt <= 0 || rawDt > SECONDARY_MOTION_RUNTIME.maxGapMs) {
      this.snapToRest('gap', sample);
      return this.finishFrame(0, { ...IDENTITY_VELOCITY }, true, 'gap', 0, startedAt);
    }
    const dtMs = clamp(rawDt, SECONDARY_MOTION_RUNTIME.minDtMs, SECONDARY_MOTION_RUNTIME.maxGapMs);
    const dtSeconds = dtMs / 1000;

    const delta: HeadAngularVelocity = {
      yaw: shortestAngleDeltaDegrees(this.lastSample.yawDeg, sample.yawDeg),
      pitch: shortestAngleDeltaDegrees(this.lastSample.pitchDeg, sample.pitchDeg),
      roll: shortestAngleDeltaDegrees(this.lastSample.rollDeg, sample.rollDeg),
    };
    const headVelocity: HeadAngularVelocity = {
      yaw: delta.yaw / dtSeconds,
      pitch: delta.pitch / dtSeconds,
      roll: delta.roll / dtSeconds,
    };
    const maxDelta = Math.max(Math.abs(delta.yaw), Math.abs(delta.pitch), Math.abs(delta.roll));
    const maxSpeed = Math.max(
      Math.abs(headVelocity.yaw),
      Math.abs(headVelocity.pitch),
      Math.abs(headVelocity.roll),
    );
    this.updateCount += 1;
    if (
      maxDelta > SECONDARY_MOTION_RUNTIME.maxPoseDeltaDeg ||
      maxSpeed > SECONDARY_MOTION_RUNTIME.maxHeadSpeedDegPerSec
    ) {
      this.snapToRest('discontinuity', sample);
      return this.finishFrame(0, { ...IDENTITY_VELOCITY }, true, 'discontinuity', 0, startedAt);
    }
    this.lastSample = { ...sample };

    // Split the frame interval into equal sub-steps of at most 1/120 s. The
    // split (not a per-frame fixed step) is what makes a given accepted-pose
    // sequence deterministic: no sub-step absorbs a different remainder.
    const stepCount = Math.max(1, Math.ceil(dtMs / SECONDARY_MOTION_RUNTIME.maxSubStepMs));
    const stepSeconds = dtSeconds / stepCount;
    for (const state of this.states) {
      const part = state.part;
      const fullScale = SECONDARY_MOTION_RUNTIME.driveFullScaleDegPerSec;
      const targetOffset =
        part.maxAngleDeg * clamp(driveValue(headVelocity, part.drive) / fullScale, -1, 1);
      const target = clamp(
        part.restAngleDeg + targetOffset,
        -part.maxAngleDeg,
        part.maxAngleDeg,
      );
      const omega = Math.sqrt(part.stiffness);
      for (let step = 0; step < stepCount; step += 1) {
        const acceleration =
          omega * omega * (target - state.angleDeg) -
          2 * part.damping * omega * state.velocityDegPerSec;
        state.velocityDegPerSec += acceleration * stepSeconds;
        state.angleDeg += state.velocityDegPerSec * stepSeconds;
        if (state.angleDeg > part.maxAngleDeg) {
          state.angleDeg = part.maxAngleDeg;
          state.velocityDegPerSec = Math.min(0, state.velocityDegPerSec);
        } else if (state.angleDeg < -part.maxAngleDeg) {
          state.angleDeg = -part.maxAngleDeg;
          state.velocityDegPerSec = Math.max(0, state.velocityDegPerSec);
        }
      }
    }
    this.totalSteps += stepCount;
    return this.finishFrame(
      dtMs,
      headVelocity,
      false,
      null,
      stepCount,
      startedAt,
    );
  }

  /**
   * Resets all part state to rest. When a sample is supplied the next frame
   * integrates from rest starting at that sample, so a gap or discontinuity
   * costs exactly one rest frame instead of a second synthetic reset.
   */
  private snapToRest(reason: SecondaryMotionResetReason, resumeSample?: HeadRotationSample): void {
    this.initialized = resumeSample !== undefined;
    this.lastSample = resumeSample ? { ...resumeSample } : null;
    this.lastResetReason = reason;
    this.resetCount += 1;
    this.setRestState();
  }

  /** Drops every part's accumulated angle and velocity to its declared rest pose. */
  private setRestState(): void {
    for (const state of this.states) {
      state.angleDeg = state.part.restAngleDeg;
      state.velocityDegPerSec = 0;
    }
  }

  private maxAbsAngle(): number {
    let maximum = 0;
    for (const state of this.states) maximum = Math.max(maximum, Math.abs(state.angleDeg));
    return maximum;
  }

  private finishFrame(
    dtMs: number,
    headVelocity: HeadAngularVelocity,
    reset: boolean,
    resetReason: SecondaryMotionResetReason | null,
    steps: number,
    startedAt: number,
  ): SecondaryMotionFrame {
    const anglesDeg = this.states.map((state) => state.angleDeg);
    const headSpeedDegPerSec = Math.max(
      Math.abs(headVelocity.yaw),
      Math.abs(headVelocity.pitch),
      Math.abs(headVelocity.roll),
    );
    this.lastFrame = {
      dtMs,
      anglesDeg,
      maxAbsAngleDeg: this.maxAbsAngle(),
      headVelocityDegPerSec: headVelocity,
      headSpeedDegPerSec,
      reset,
      resetReason,
      steps,
      costMs: performance.now() - startedAt,
    };
    return this.lastFrame;
  }
}

/**
 * Converts a validated declaration to radians for a renderer that applies the
 * angles to Three.js node quaternions.
 */
export function secondaryMotionAnglesRadians(anglesDeg: readonly number[]): number[] {
  return anglesDeg.map((angle) => (angle * Math.PI) / 180);
}
