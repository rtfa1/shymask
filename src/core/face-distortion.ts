/**
 * Pure mapping from the tracked face box + a validated `faceDistortion`
 * declaration to the screen-space warp the renderer applies.
 *
 * The distortion is a fixed radial warp of the video inside an ellipse that is
 * derived from the tracked face box. It is not a screen-space overlay and the
 * package cannot supply geometry, a shader or per-frame code: `mode` selects a
 * fixed code path and `strength`, `radiusScale` and `centerOffset` are bounded
 * numbers (see `FACE_DISTORTION_LIMITS`). Because the ellipse is recomputed for
 * every processed frame from the tracker's face box, the warp centre and size
 * follow the recorded face's movement and distance.
 *
 * Keeping the mapping here (no DOM, no WebGL) lets unit tests assert that the
 * warp follows the face and that the bounded strength maps to a bounded
 * displacement; the renderer only uploads these numbers as shader uniforms.
 */

import {
  FACE_DISTORTION_LIMITS,
  type FaceDistortionParameters,
} from './effect-package-contract';

/** One detected face box in normalized frame coordinates (0-1, origin top-left). */
export interface NormalizedFaceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Screen-space warp geometry in normalized frame coordinates. */
export interface FaceDistortionGeometry {
  /** Warp ellipse centre, normalized output coordinates. */
  centerX: number;
  centerY: number;
  /** Warp ellipse radii, normalized output coordinates (always positive). */
  radiusX: number;
  radiusY: number;
  /**
   * Signed effective radial factor at the ellipse centre. Positive `scale` is
   * used for a bulge (the sampled source radius shrinks), negative for a pinch
   * (the sampled source radius grows): `sampledRadius = 1 - warpFactor`.
   */
  warpFactor: number;
}

/**
 * Diagnostic comparison between an identity and a warped render of the same
 * uploaded frame texture. Both passes use the same shader resolution and
 * texture, so a nonzero inside-ellipse delta is the warp itself and the outside
 * delta is exactly zero apart from GPU rounding.
 */
export interface FrameDeltaStats {
  /** Number of low-resolution samples compared. */
  sampledPixels: number;
  /** Samples whose normalized coordinates fall inside the warp ellipse. */
  insidePixels: number;
  /** Mean absolute per-channel difference over all samples (0-255). */
  meanAbsDiff: number;
  /** Percentage of inside-ellipse samples whose max channel diff exceeds 8. */
  changedInsidePct: number;
  /** Percentage of outside-ellipse samples whose max channel diff exceeds 8. */
  changedOutsidePct: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Resolves the warp ellipse and strength for one processed frame.
 *
 * `centerOffset` is deliberately applied per axis relative to each face-box
 * dimension, so an offset that keeps the warp over the face in a wide, close
 * face box does the same in a narrow, distant one.
 */
export function faceDistortionGeometry(
  face: NormalizedFaceRect,
  parameters: FaceDistortionParameters,
): FaceDistortionGeometry {
  const width = Math.max(0, face.width);
  const height = Math.max(0, face.height);
  const centerX = face.x + width * (0.5 + parameters.centerOffset[0]);
  const centerY = face.y + height * (0.5 + parameters.centerOffset[1]);
  const radiusX = Math.max(
    1e-4,
    (width / 2) * clamp(parameters.radiusScale, FACE_DISTORTION_LIMITS.minRadiusScale, FACE_DISTORTION_LIMITS.maxRadiusScale),
  );
  const radiusY = Math.max(
    1e-4,
    (height / 2) * clamp(parameters.radiusScale, FACE_DISTORTION_LIMITS.minRadiusScale, FACE_DISTORTION_LIMITS.maxRadiusScale),
  );
  const direction = parameters.mode === 'bulge' ? 1 : -1;
  const warpFactor =
    direction * clamp(parameters.strength, FACE_DISTORTION_LIMITS.minStrength, FACE_DISTORTION_LIMITS.maxStrength) *
    FACE_DISTORTION_LIMITS.maxWarpFactor;
  return { centerX, centerY, radiusX, radiusY, warpFactor };
}

/**
 * Health inputs for the distortion renderer's drawability decision.
 *
 * A WebGL context can be lost at any time (GPU reset, driver restart, power
 * state change). Three.js then silently returns from `render()` without drawing,
 * so the caller must not composite the renderer canvas: it may hold a stale or
 * blank frame. The renderer marks itself non-drawable and the pipeline keeps the
 * previous output until the existing undrawable guard hides it; there is never
 * a fallback to the raw frame.
 */
export interface DistortionRenderHealth {
  /** The renderer was disposed and must not draw. */
  disposed: boolean;
  /** The canvas received a `webglcontextlost` event. */
  contextLost: boolean;
  /** The live WebGL context also reports itself lost (defensive check). */
  glContextLost: boolean;
}

/** True only when the distortion renderer can draw a trustworthy frame. */
export function distortionRenderable(health: DistortionRenderHealth): boolean {
  return !health.disposed && !health.contextLost && !health.glContextLost;
}

/**
 * True when a normalized output point lies inside the warp ellipse. Used by the
 * renderer's local warp-delta diagnostic to report how much of the change is
 * inside the tracked face region versus outside it; the shader uses the same
 * normalized ellipse test.
 */
export function faceDistortionContains(
  geometry: FaceDistortionGeometry,
  normalizedX: number,
  normalizedY: number,
): boolean {
  const dx = (normalizedX - geometry.centerX) / geometry.radiusX;
  const dy = (normalizedY - geometry.centerY) / geometry.radiusY;
  return dx * dx + dy * dy < 1;
}
