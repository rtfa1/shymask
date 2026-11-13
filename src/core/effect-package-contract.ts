/**
 * Shymask effect package contract (declarative, no executable effect code).
 *
 * A package is a ZIP archive containing exactly one root `manifest.json` and
 * only the assets the manifest declares under `assets/`. This module owns the
 * wire shape, the bounded parameter ranges and the shared view of an installed
 * package. It deliberately has no Node.js or Electron dependency so the main
 * process, the renderer and the unit tests share one definition.
 *
 * See docs/effect-packages.md for the creator-facing contract and
 * docs/adr/0004-declarative-effect-packages.md for the decision.
 */

/** Oldest schema this build still accepts. */
export const MIN_EFFECT_PACKAGE_SCHEMA_VERSION = 1;

/**
 * Current package schema. Version 2 adds the optional `faceDistortion`
 * component; version 3 adds the optional bounded `secondaryMotion` component
 * (a small set of spring-driven movable mask parts). Version 1 packages (mask
 * and/or color treatment) and version 2 packages remain accepted unchanged.
 */
export const EFFECT_PACKAGE_SCHEMA_VERSION = 3;

/**
 * Every schema version this build accepts, in ascending order. This literal list
 * must stay in sync with `MIN_EFFECT_PACKAGE_SCHEMA_VERSION` and
 * `EFFECT_PACKAGE_SCHEMA_VERSION`; the schema-version tests cover both ends.
 */
export const SUPPORTED_EFFECT_PACKAGE_SCHEMA_VERSIONS = [1, 2, 3] as const;

export type EffectPackageSchemaVersion = (typeof SUPPORTED_EFFECT_PACKAGE_SCHEMA_VERSIONS)[number];

/**
 * The first schema version that understands `faceDistortion`. Declaring the
 * component in a v1 manifest is rejected instead of silently ignored, because
 * an older v1-only build would otherwise accept the package and drop the
 * effect.
 */
export const FACE_DISTORTION_SCHEMA_VERSION = 2;

/** Manifest file name at the archive root (case-sensitive on every platform). */
export const PACKAGE_MANIFEST_PATH = 'manifest.json';

/** Asset folder prefix inside the archive. */
export const PACKAGE_ASSET_PREFIX = 'assets/';

/**
 * Import-safety caps. These bound ZIP/ZIP-bomb and mismatch risk only; they are
 * NOT the measured complexity budgets from issue #11. `validateEffectPackage`
 * reports the actual measurements (`PackageComplexity`) for that later slice to
 * turn into budgets once they are measured on real authoring output.
 */
export const PACKAGE_SAFETY_LIMITS = {
  /** Whole archive bytes. */
  maxArchiveBytes: 8 * 1024 * 1024,
  /** Compressed size of any single archive entry. */
  maxEntryCompressedBytes: 4 * 1024 * 1024,
  /** Uncompressed (declared and verified) size of any single entry. */
  maxEntryUncompressedBytes: 4 * 1024 * 1024,
  /** Total declared uncompressed bytes across the archive. */
  maxTotalUncompressedBytes: 8 * 1024 * 1024,
  /** Number of central-directory entries, including ignored directories. */
  maxEntries: 64,
  /** `manifest.json` bytes. */
  maxManifestBytes: 64 * 1024,
  /** A declared mask asset must stay within this, independent of the ZIP cap. */
  maxMaskAssetBytes: 4 * 1024 * 1024,
} as const;

/** Bounded color-treatment parameters. Absent parameters are not applied. */
export interface ColorTreatmentParameters {
  /** Canvas `brightness()`, 0.25-2. */
  brightness?: number;
  /** Canvas `contrast()`, 0.25-2. */
  contrast?: number;
  /** Canvas `saturate()`, 0-3. */
  saturation?: number;
  /** Canvas `hue-rotate()`, -180 to 180 degrees. */
  hueRotateDeg?: number;
  /** Canvas `sepia()`, 0-1. */
  sepia?: number;
  /** Canvas `grayscale()`, 0-1. */
  grayscale?: number;
}

export interface ColorParameterBound {
  key: keyof ColorTreatmentParameters;
  min: number;
  max: number;
}

/**
 * Supported color parameters and their inclusive bounds. Bounds exist because
 * the filter is applied by the browser; they are not complexity budgets.
 */
export const COLOR_PARAMETER_BOUNDS: readonly ColorParameterBound[] = [
  { key: 'brightness', min: 0.25, max: 2 },
  { key: 'contrast', min: 0.25, max: 2 },
  { key: 'saturation', min: 0, max: 3 },
  { key: 'hueRotateDeg', min: -180, max: 180 },
  { key: 'sepia', min: 0, max: 1 },
  { key: 'grayscale', min: 0, max: 1 },
];

/** Where the rigid mask sits relative to the tracked face, in canonical cm. */
export interface MaskAttachment {
  /** Offset from the canonical face origin, centimetres. Each axis -30..30. */
  position: readonly [number, number, number];
  /** Euler rotation in degrees, each axis -180..180. */
  rotationDeg: readonly [number, number, number];
  /** Uniform scale, 0.1-5. */
  scale: number;
}

export const MASK_ATTACHMENT_LIMITS = {
  maxPositionCm: 30,
  maxRotationDeg: 180,
  minScale: 0.1,
  maxScale: 5,
} as const;

export const DEFAULT_MASK_ATTACHMENT: MaskAttachment = {
  position: [0, 0, 0],
  rotationDeg: [0, 0, 0],
  scale: 1,
};

/**
 * Bounded face-distortion modes. The runtime applies a fixed radial warp; the
 * package selects a mode and bounded numbers, never code or a mesh.
 */
export const FACE_DISTORTION_MODES = ['bulge', 'pinch'] as const;

export type FaceDistortionMode = (typeof FACE_DISTORTION_MODES)[number];

export const FACE_DISTORTION_LIMITS = {
  /** 0 is valid but a no-op; the absolute strength bound is 1. */
  minStrength: 0,
  maxStrength: 1,
  /** Warp ellipse radius relative to half the tracked face box, per axis. */
  minRadiusScale: 0.25,
  maxRadiusScale: 2.5,
  /** Warp centre offset as a fraction of the tracked face box width/height. */
  maxCenterOffset: 0.5,
  /**
   * Fixed runtime constant: how far the centre sample radius may move at
   * maximum strength. 0.75 keeps the bulge magnification bounded (1 / 0.25)
   * and the pinch sampling within a bounded neighbourhood of the face.
   */
  maxWarpFactor: 0.75,
} as const;

/**
 * Declarative face distortion, attached to the tracked face box. All values are
 * bounded by `FACE_DISTORTION_LIMITS`; validation resolves optional fields to
 * these defaults.
 */
export interface FaceDistortionParameters {
  /** `bulge` magnifies the enclosed face region; `pinch` shrinks it. */
  mode: FaceDistortionMode;
  /** 0 (no-op) to 1 (bounded maximum). */
  strength: number;
  /** Radius of the warp ellipse relative to half the tracked face box, per axis. */
  radiusScale: number;
  /**
   * Warp centre offset from the tracked face box centre, as a fraction of the
   * box width (x) and height (y). Each axis -0.5 to 0.5.
   */
  centerOffset: readonly [number, number];
}

export const DEFAULT_FACE_DISTORTION = {
  radiusScale: 1,
  centerOffset: [0, 0] as readonly [number, number],
} as const;

/**
 * The first schema version that understands `secondaryMotion`. Declaring the
 * component in a v1/v2 manifest is rejected instead of silently ignored,
 * because an older build would otherwise import a package whose declared
 * moving parts never move.
 */
export const SECONDARY_MOTION_SCHEMA_VERSION = 3;

/** Local rotation axes a movable part may swing around. */
export const SECONDARY_MOTION_AXES = ['x', 'y', 'z'] as const;

export type SecondaryMotionAxis = (typeof SECONDARY_MOTION_AXES)[number];

/** Tracked head-rotation components that may drive a movable part. */
export const SECONDARY_MOTION_DRIVES = ['yaw', 'pitch', 'roll'] as const;

export type SecondaryMotionDrive = (typeof SECONDARY_MOTION_DRIVES)[number];

/**
 * Validation bounds for a package's secondary-motion declaration. These are
 * contract bounds, not complexity budgets: every part is a named GLB node that
 * rotates about one local axis; the package cannot supply code, geometry or
 * per-frame motion.
 */
export const SECONDARY_MOTION_LIMITS = {
  /** A mask may declare at most this many movable parts. */
  maxParts: 4,
  /** Node name length in the mask GLB (ASCII, no spaces). */
  maxNodeNameLength: 64,
  /**
   * Angular spring stiffness in 1/s^2. The undamped natural frequency is
   * sqrt(stiffness) rad/s, so 4 is a slow swing and 400 is a fast flutter.
   */
  minStiffness: 4,
  maxStiffness: 400,
  /** Dimensionless damping ratio; below 1 overshoots, 1 is critically damped. */
  minDampingRatio: 0.05,
  maxDampingRatio: 1.5,
  /** Hard position bound per part, in degrees from the declared rest pose. */
  minMaxAngleDeg: 1,
  maxMaxAngleDeg: 60,
  /** Optional constant rest offset from the authored GLB pose, in degrees. */
  maxRestAngleDeg: 60,
} as const;

/**
 * Fixed runtime constants for the spring simulation. They are shared by the
 * simulator and its tests but are deliberately not package-tunable.
 */
export const SECONDARY_MOTION_RUNTIME = {
  /**
   * Fixed runtime sensitivity: the spring target reaches `maxAngleDeg` when the
   * tracked head rotates at this many degrees per second around `drive`.
   */
  driveFullScaleDegPerSec: 45,
  /**
   * Largest integration sub-step. Each frame interval is split into
   * `ceil(dtMs / maxSubStepMs)` equal sub-steps of at most this long; the
   * split is deterministic for a given accepted-pose sequence.
   */
  maxSubStepMs: 1000 / 120,
  /** Smallest accepted `dt`; shorter positive intervals are clamped up to this. */
  minDtMs: 0.5,
  /** Largest accepted input gap before the state deliberately resets. */
  maxGapMs: 250,
  /** A per-sample pose discontinuity beyond these resets instead of driving. */
  maxPoseDeltaDeg: 45,
  maxHeadSpeedDegPerSec: 1080,
} as const;

/**
 * One declarative movable mask part. `node` names a node in the package mask
 * GLB; the runtime records that node's authored orientation as the zero-offset
 * base. The declared rest pose is that orientation plus `restAngleDeg`, and the
 * simulated angle is applied about `axis` driven by the tracked head angular
 * velocity around `drive`.
 */
export interface SecondaryMotionPart {
  /** Node name in the mask GLB (exactly one node must match). */
  node: string;
  /** Local rotation axis of the node, `x`/`y`/`z`. */
  axis: SecondaryMotionAxis;
  /** Tracked head-rotation component that drives the spring. */
  drive: SecondaryMotionDrive;
  /** Angular spring stiffness in 1/s^2, 4-400. */
  stiffness: number;
  /** Damping ratio, 0.05-1.5. */
  damping: number;
  /** Hard bound on the applied angle in degrees, 1-60. */
  maxAngleDeg: number;
  /** Optional constant angle offset from the authored GLB orientation, -60 to 60. */
  restAngleDeg: number;
}

/** Bounded secondary-motion declaration: 1-4 named spring-driven parts. */
export interface SecondaryMotionParameters {
  parts: readonly SecondaryMotionPart[];
}

export interface EffectPackageAuthor {
  name: string;
  /** Free-form credit line, e.g. "Generated by scripts/build-package-fixtures.mjs". */
  attribution?: string;
  /** SPDX-ish license label such as "CC0-1.0". Informational only. */
  license?: string;
  /** Optional http(s) source page. */
  url?: string;
}

export interface MaskComponentV1 {
  /** Archive-relative asset path: `assets/<file>.glb`, exactly one level. */
  asset: string;
  /** Attachment resolved by validation (omitted manifest fields get defaults). */
  attachment?: MaskAttachment;
}

/**
 * Declarative manifest. Schema v2 adds the optional `faceDistortion`
 * component; v1 manifests may declare a mask and/or color treatment but must
 * declare `schemaVersion: 1`. Expression reactions and other behavioral
 * declarations are reserved: a non-empty declaration is rejected as
 * unsupported rather than silently ignored.
 */
export interface EffectPackageManifest {
  schemaVersion: EffectPackageSchemaVersion;
  id: string;
  name: string;
  version: string;
  description: string;
  author: EffectPackageAuthor;
  mask?: MaskComponentV1;
  colorTreatment?: ColorTreatmentParameters;
  /** Bounded face distortion (schema v2+). */
  faceDistortion?: FaceDistortionParameters;
  /** Bounded spring-driven movable mask parts (schema v3+). */
  secondaryMotion?: SecondaryMotionParameters;
  /** Reserved for a later slice; must be absent or an empty array in v1. */
  expressionReactions?: readonly unknown[];
  /** Reserved; use `secondaryMotion` for supported moving-part behavior. */
  behaviors?: readonly unknown[];
}

export type PackageIssueSeverity = 'error' | 'warning';

/**
 * Stable validation codes. Each code has a documented, actionable message and
 * is exercised by the unit suite (`tests/validation-coverage.test.ts`) or a
 * committed negative fixture; `tests/validation-coverage.test.ts` fails if a
 * code in this list is never produced. `PackageIssueCode` is derived from this
 * runtime list so the documentation/coverage guard and the type cannot drift.
 */
export const PACKAGE_ISSUE_CODES = [
  'archive-too-large',
  'archive-unreadable',
  'entry-count-exceeded',
  'entry-too-large',
  'entry-compression-unsupported',
  'entry-encrypted',
  'entry-duplicate',
  'entry-path-unsafe',
  'entry-symlink',
  'entry-not-allowed',
  'executable-content',
  'manifest-missing',
  'manifest-too-large',
  'manifest-not-utf8',
  'manifest-invalid-json',
  'manifest-schema-invalid',
  'schema-version-unsupported',
  'identity-invalid',
  'empty-effect',
  'unsupported-behavior',
  'unsupported-asset-type',
  'missing-asset',
  'color-parameter-out-of-range',
  'attachment-invalid',
  'distortion-invalid',
  'secondary-motion-invalid',
  'glb-invalid',
  'glb-external-resource',
  'glb-unsupported-extension',
  'glb-unsupported-feature',
  'unknown-field',
] as const;

export type PackageIssueCode = (typeof PACKAGE_ISSUE_CODES)[number];

export interface PackageIssue {
  severity: PackageIssueSeverity;
  code: PackageIssueCode;
  /** Actionable, creator-facing explanation. */
  message: string;
  /** Archive path or manifest field this issue refers to, when known. */
  path?: string;
}

/** Structural measurements reported for the later complexity-budget slice. */
export interface PackageComplexity {
  archiveBytes: number;
  entryCount: number;
  manifestBytes: number;
  maskAssetBytes: number;
  /** Triangle count summed over every glTF primitive in the mask asset. */
  triangles: number;
  meshes: number;
  materials: number;
  nodes: number;
  textures: number;
  /** Declared behavior entries rejected by validation (always 0 when accepted). */
  declaredBehaviors: number;
  /** Count of color-treatment parameters declared. */
  colorParameters: number;
  /** 1 when a bounded face-distortion component is declared, else 0. */
  distortionParameters: number;
  /** Declared movable parts (0-4 for an accepted secondary-motion declaration). */
  movingParts: number;
}

/**
 * The renderer-facing view of an installed package. Only validated, plain data:
 * no archive bytes and no executable content.
 */
export interface InstalledEffectPackage {
  /** Package id from the manifest (stable identity across re-imports). */
  id: string;
  name: string;
  version: string;
  description: string;
  author: EffectPackageAuthor;
  treatment: ColorTreatmentParameters | null;
  /** Bounded face distortion, or null when the package does not declare one. */
  distortion: FaceDistortionParameters | null;
  /** Bounded spring-driven movable mask parts, or null when none are declared. */
  secondaryMotion: SecondaryMotionParameters | null;
  mask: {
    /** Archive-relative asset path, for diagnostics. */
    asset: string;
    /** `shymask://app/packages/<id>/<asset>` URL served by the local protocol. */
    assetUrl: string;
    attachment: MaskAttachment;
  } | null;
  complexity: PackageComplexity;
  /** ISO timestamp of the import that produced the stored copy. */
  importedAt: string;
  /** Original archive file name (basename only). */
  sourceFileName: string;
}

export interface EffectPackageList {
  packages: InstalledEffectPackage[];
  /** Non-fatal store problems, e.g. an ignored package that failed revalidation. */
  warnings: string[];
}

export interface ImportEffectPackageResult {
  status: 'imported' | 'rejected' | 'cancelled' | 'failed';
  /** Short human-readable outcome; errors include the first actionable issue. */
  message: string;
  issues: PackageIssue[];
  package?: InstalledEffectPackage;
  list: EffectPackageList;
}

export interface RemoveEffectPackageResult {
  removed: boolean;
  message: string;
  list: EffectPackageList;
}

/** Builds the only CSS filter expression a package may produce. */
export function buildTreatmentCssFilter(parameters: ColorTreatmentParameters): string {
  const parts: string[] = [];
  if (parameters.brightness !== undefined) parts.push(`brightness(${parameters.brightness})`);
  if (parameters.contrast !== undefined) parts.push(`contrast(${parameters.contrast})`);
  if (parameters.saturation !== undefined) parts.push(`saturate(${parameters.saturation})`);
  if (parameters.hueRotateDeg !== undefined) parts.push(`hue-rotate(${parameters.hueRotateDeg}deg)`);
  if (parameters.sepia !== undefined) parts.push(`sepia(${parameters.sepia})`);
  if (parameters.grayscale !== undefined) parts.push(`grayscale(${parameters.grayscale})`);
  return parts.join(' ');
}

export function countDeclaredColorParameters(parameters: ColorTreatmentParameters): number {
  return COLOR_PARAMETER_BOUNDS.filter((bound) => parameters[bound.key] !== undefined).length;
}

/** Package effect selector id, namespaced so it cannot collide with bundled ids. */
export function effectIdForPackage(packageId: string): string {
  return `package:${packageId}`;
}
