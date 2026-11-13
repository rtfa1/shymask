/**
 * Bounded, speed-adaptive smoothing for the tracked face matrix used by the
 * mask renderer.
 *
 * The tracker's per-frame facial transformation matrix is already a good rigid
 * fit, but its residual per-frame noise is visible as mask jitter, and one
 * glitched jump is already rejected by the tracking state machine. Smoothing
 * must not turn into unbounded lag: Shymask renders a mask that covers the face,
 * so a mask that trails the face is as visible as one that jitters.
 *
 * The filter is an exponential smoother with a speed-adaptive gain:
 *
 *   motion = max(linearSpeed / FULL_TRANSLATION_SPEED_CM_S,
 *                angularSpeed / FULL_ROTATION_SPEED_DEG_S)   clamped to [0, 1]
 *   alphaRef = BASE_ALPHA + (1 - BASE_ALPHA) * motion
 *   alpha = 1 - (1 - alphaRef) ^ (dt / REFERENCE_FRAME_MS)
 *
 * At rest the gain is `BASE_ALPHA`, which suppresses high-frequency jitter; as
 * the tracked face moves faster the gain approaches 1, so real turns, nods and
 * leans pass through without extra lag. The gain never drops below
 * `BASE_ALPHA`, so the constant-velocity lag is bounded by
 *
 *   (1 - BASE_ALPHA) / BASE_ALPHA * frame interval
 *
 * (about 51 ms at the 24 Hz reference interval with `BASE_ALPHA = 0.45`). That
 * 51 ms figure is a reference-interval bound, not a global maximum: the gain is
 * normalized to `referenceFrameMs`, so at the observed ~35 ms presented-frame
 * interval the effective per-sample gain is about 0.34 and the measured
 * constant-velocity ramp lag is about 61 ms (reported separately from this
 * reference bound). A safety cap additionally snaps the filter toward the raw
 * pose if a measured offset ever exceeds `MAX_TRANSLATION_LAG_CM` /
 * `MAX_ROTATION_LAG_DEG`.
 *
 * The transform math is self-contained (no Three.js or DOM-rendering
 * dependency), but this class is stateful: `push()` retains the previous pose and
 * calls `performance.now()` for its cost metric. The math, the bound and the
 * reset behavior are unit-tested without a WebGL context. Rotation is smoothed
 * as a quaternion (shortest arc) and translation component-wise.
 */

export const POSE_SMOOTHING_LIMITS = {
  /** Gain at zero measured speed. Higher means less smoothing and less lag. */
  baseAlpha: 0.45,
  /** The frame interval the gain is normalized to (about 24 presented frames/s). */
  referenceFrameMs: 1000 / 24,
  /** Measured speed at which the filter fully trusts the new sample. */
  fullRotationSpeedDegPerSec: 360,
  fullTranslationSpeedCmPerSec: 60,
  /** A gap longer than this snaps instead of smoothing across the pause. */
  maxGapMs: 250,
  /** Hard safety caps; normally the adaptive gain keeps the offset far below them. */
  maxTranslationLagCm: 4,
  maxRotationLagDeg: 8,
} as const;

export interface PoseFilterStats {
  /** Gain applied to this sample, 0..1. */
  alpha: number;
  /** Measured offset between the raw and rendered translation (centimetres). */
  translationLagCm: number;
  /** Measured offset between the raw and rendered orientation (degrees). */
  rotationLagDeg: number;
  /** Constant-velocity delay implied by `alpha` this sample (milliseconds). */
  rampLagMs: number;
  /** Cost of this filter call (milliseconds). */
  costMs: number;
  /** True when the sample was applied directly instead of filtered. */
  snapped: boolean;
}

export interface PoseFilterSnapshot extends PoseFilterStats {
  /** Samples pushed since construction or the last reset. */
  samples: number;
}

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];

const IDENTITY_QUAT: Quat = [0, 0, 0, 1];

const EMPTY_STATS: PoseFilterStats = {
  alpha: 1,
  translationLagCm: 0,
  rotationLagDeg: 0,
  rampLagMs: 0,
  costMs: 0,
  snapped: true,
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function finiteMatrix(matrix: ArrayLike<number>): boolean {
  if (matrix.length < 16) return false;
  for (let index = 0; index < 16; index += 1) {
    const value = matrix[index];
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  }
  return true;
}

function normalizeQuat(quaternion: Quat): Quat {
  const length = Math.hypot(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
  if (length < 1e-9) return [...IDENTITY_QUAT];
  return [quaternion[0] / length, quaternion[1] / length, quaternion[2] / length, quaternion[3] / length];
}

/**
 * Extracts the rotation quaternion and uniform scale from a column-major rigid
 * transform. MediaPipe facial transformation matrices carry no scale (the
 * canonical model is already in centimetres), but averaging the three column
 * lengths keeps a slightly scaled matrix sane instead of silently distorting it.
 */
function decomposeColumnMajor(matrix: ArrayLike<number>): {
  position: Vec3;
  quaternion: Quat;
  scale: number;
} {
  const m00 = matrix[0] as number;
  const m01 = matrix[1] as number;
  const m02 = matrix[2] as number;
  const m10 = matrix[4] as number;
  const m11 = matrix[5] as number;
  const m12 = matrix[6] as number;
  const m20 = matrix[8] as number;
  const m21 = matrix[9] as number;
  const m22 = matrix[10] as number;

  const scaleX = Math.hypot(m00, m01, m02);
  const scaleY = Math.hypot(m10, m11, m12);
  const scaleZ = Math.hypot(m20, m21, m22);
  const scale = (scaleX + scaleY + scaleZ) / 3;
  const safeScale = scale > 1e-9 ? scale : 1;

  // Column-major indices, normalized: R[row][column].
  const r00 = m00 / safeScale;
  const r10 = m01 / safeScale;
  const r20 = m02 / safeScale;
  const r01 = m10 / safeScale;
  const r11 = m11 / safeScale;
  const r21 = m12 / safeScale;
  const r02 = m20 / safeScale;
  const r12 = m21 / safeScale;
  const r22 = m22 / safeScale;

  const trace = r00 + r11 + r22;
  let x = 0;
  let y = 0;
  let z = 0;
  let w = 1;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = 0.25 * s;
    x = (r21 - r12) / s;
    y = (r02 - r20) / s;
    z = (r10 - r01) / s;
  } else if (r00 > r11 && r00 > r22) {
    const s = Math.sqrt(1 + r00 - r11 - r22) * 2;
    w = (r21 - r12) / s;
    x = 0.25 * s;
    y = (r01 + r10) / s;
    z = (r02 + r20) / s;
  } else if (r11 > r22) {
    const s = Math.sqrt(1 + r11 - r00 - r22) * 2;
    w = (r02 - r20) / s;
    x = (r01 + r10) / s;
    y = 0.25 * s;
    z = (r12 + r21) / s;
  } else {
    const s = Math.sqrt(1 + r22 - r00 - r11) * 2;
    w = (r10 - r01) / s;
    x = (r02 + r20) / s;
    y = (r12 + r21) / s;
    z = 0.25 * s;
  }

  return {
    position: [matrix[12] as number, matrix[13] as number, matrix[14] as number],
    quaternion: normalizeQuat([x, y, z, w]),
    scale,
  };
}

/** Composes a column-major transform from a rotation quaternion, position and uniform scale. */
function composeColumnMajor(position: Vec3, quaternion: Quat, scale: number): number[] {
  const [x, y, z, w] = quaternion;
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  return [
    (1 - 2 * (yy + zz)) * scale,
    2 * (xy + wz) * scale,
    2 * (xz - wy) * scale,
    0,
    2 * (xy - wz) * scale,
    (1 - 2 * (xx + zz)) * scale,
    2 * (yz + wx) * scale,
    0,
    2 * (xz + wy) * scale,
    2 * (yz - wx) * scale,
    (1 - 2 * (xx + yy)) * scale,
    0,
    position[0],
    position[1],
    position[2],
    1,
  ];
}

function slerp(from: Quat, to: Quat, amount: number): Quat {
  let [bx, by, bz, bw] = to;
  let dot = from[0] * bx + from[1] * by + from[2] * bz + from[3] * bw;
  if (dot < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
    dot = -dot;
  }
  if (dot > 0.9995) {
    // Nearly identical: linear interpolation avoids an unstable short arc.
    return normalizeQuat([
      from[0] + (bx - from[0]) * amount,
      from[1] + (by - from[1]) * amount,
      from[2] + (bz - from[2]) * amount,
      from[3] + (bw - from[3]) * amount,
    ]);
  }
  const theta = Math.acos(clamp(dot, -1, 1));
  const sinTheta = Math.sin(theta);
  const fromWeight = Math.sin((1 - amount) * theta) / sinTheta;
  const toWeight = Math.sin(amount * theta) / sinTheta;
  return normalizeQuat([
    from[0] * fromWeight + bx * toWeight,
    from[1] * fromWeight + by * toWeight,
    from[2] * fromWeight + bz * toWeight,
    from[3] * fromWeight + bw * toWeight,
  ]);
}

function quatAngleDegrees(left: Quat, right: Quat): number {
  const dot = Math.abs(left[0] * right[0] + left[1] * right[1] + left[2] * right[2] + left[3] * right[3]);
  return (2 * Math.acos(clamp(dot, -1, 1)) * 180) / Math.PI;
}

function distance(left: Vec3, right: Vec3): number {
  return Math.hypot(right[0] - left[0], right[1] - left[1], right[2] - left[2]);
}

export class PoseSmoother {
  private initialized = false;
  private lastRawPosition: Vec3 = [0, 0, 0];
  private lastRawQuaternion: Quat = [...IDENTITY_QUAT];
  private lastTimeMs = 0;
  private position: Vec3 = [0, 0, 0];
  private quaternion: Quat = [...IDENTITY_QUAT];
  private scale = 1;
  private stats: PoseFilterStats = { ...EMPTY_STATS };
  private sampleCount = 0;

  /**
   * Constant-velocity delay of the base gain at the reference frame interval
   * (about 51 ms at 24 Hz). This is not a global maximum: the gain is normalized
   * to `referenceFrameMs`, so a longer presented-frame interval produces a
   * proportionally larger ramp lag. The measured p95 at the observed interval is
   * reported separately as `rampLagMs`.
   */
  get referenceRampLagMs(): number {
    return ((1 - POSE_SMOOTHING_LIMITS.baseAlpha) / POSE_SMOOTHING_LIMITS.baseAlpha) *
      POSE_SMOOTHING_LIMITS.referenceFrameMs;
  }

  reset(): void {
    this.initialized = false;
    this.stats = { ...EMPTY_STATS };
    this.sampleCount = 0;
  }

  get lastStats(): PoseFilterStats {
    return this.stats;
  }

  get snapshot(): PoseFilterSnapshot {
    return { ...this.stats, samples: this.sampleCount };
  }

  /**
   * Filters one tracker matrix and returns the matrix that should be rendered.
   * The first sample, a non-finite sample and a gap longer than
   * `maxGapMs` snap to the raw pose instead of smoothing from stale state.
   */
  push(matrix: ArrayLike<number>, nowMs: number): number[] {
    const startedAt = performance.now();
    if (!finiteMatrix(matrix)) {
      this.reset();
      this.stats = { ...EMPTY_STATS, costMs: performance.now() - startedAt };
      return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    }

    const raw = decomposeColumnMajor(matrix);
    this.sampleCount += 1;

    if (
      !this.initialized ||
      !Number.isFinite(nowMs) ||
      nowMs - this.lastTimeMs <= 0 ||
      nowMs - this.lastTimeMs > POSE_SMOOTHING_LIMITS.maxGapMs
    ) {
      this.position = [...raw.position];
      this.quaternion = [...raw.quaternion];
      this.scale = raw.scale;
      this.lastRawPosition = [...raw.position];
      this.lastRawQuaternion = [...raw.quaternion];
      this.lastTimeMs = nowMs;
      this.initialized = true;
      this.stats = {
        alpha: 1,
        translationLagCm: 0,
        rotationLagDeg: 0,
        rampLagMs: 0,
        costMs: performance.now() - startedAt,
        snapped: true,
      };
      return composeColumnMajor(this.position, this.quaternion, this.scale);
    }

    const dt = clamp(nowMs - this.lastTimeMs, 0.5, POSE_SMOOTHING_LIMITS.maxGapMs);
    const linearSpeed = (distance(this.lastRawPosition, raw.position) / dt) * 1000;
    const angularSpeed = (quatAngleDegrees(this.lastRawQuaternion, raw.quaternion) / dt) * 1000;
    const motion = clamp(
      Math.max(
        linearSpeed / POSE_SMOOTHING_LIMITS.fullTranslationSpeedCmPerSec,
        angularSpeed / POSE_SMOOTHING_LIMITS.fullRotationSpeedDegPerSec,
      ),
      0,
      1,
    );
    const alphaRef = POSE_SMOOTHING_LIMITS.baseAlpha + (1 - POSE_SMOOTHING_LIMITS.baseAlpha) * motion;
    const alpha = 1 - Math.pow(1 - alphaRef, dt / POSE_SMOOTHING_LIMITS.referenceFrameMs);

    let nextPosition: Vec3 = [
      this.position[0] + (raw.position[0] - this.position[0]) * alpha,
      this.position[1] + (raw.position[1] - this.position[1]) * alpha,
      this.position[2] + (raw.position[2] - this.position[2]) * alpha,
    ];
    let nextQuaternion = slerp(this.quaternion, raw.quaternion, alpha);

    // Hard bound: if the filtered pose trails the raw pose beyond the safety
    // caps, move it toward the raw sample enough to satisfy the cap. This is
    // normally dormant because the adaptive gain already suppresses lag during
    // motion, but it makes the delay bound independent of the recorded motion.
    let translationLagCm = distance(nextPosition, raw.position);
    let rotationLagDeg = quatAngleDegrees(nextQuaternion, raw.quaternion);
    const excess = Math.max(
      translationLagCm / POSE_SMOOTHING_LIMITS.maxTranslationLagCm,
      rotationLagDeg / POSE_SMOOTHING_LIMITS.maxRotationLagDeg,
    );
    if (excess > 1) {
      const correction = 1 - 1 / excess;
      nextPosition = [
        nextPosition[0] + (raw.position[0] - nextPosition[0]) * correction,
        nextPosition[1] + (raw.position[1] - nextPosition[1]) * correction,
        nextPosition[2] + (raw.position[2] - nextPosition[2]) * correction,
      ];
      nextQuaternion = slerp(nextQuaternion, raw.quaternion, correction);
      translationLagCm = distance(nextPosition, raw.position);
      rotationLagDeg = quatAngleDegrees(nextQuaternion, raw.quaternion);
    }

    this.position = nextPosition;
    this.quaternion = nextQuaternion;
    this.scale += (raw.scale - this.scale) * alpha;
    this.lastRawPosition = [...raw.position];
    this.lastRawQuaternion = [...raw.quaternion];
    this.lastTimeMs = nowMs;
    this.stats = {
      alpha,
      translationLagCm,
      rotationLagDeg,
      rampLagMs: (1 - alpha) / alpha * dt,
      costMs: performance.now() - startedAt,
      snapped: false,
    };
    return composeColumnMajor(this.position, this.quaternion, this.scale);
  }
}
