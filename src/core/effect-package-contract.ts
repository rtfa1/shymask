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

/**
 * Oldest schema this build still accepts. The supported list below is derived
 * from this value and the current schema version, so the constants cannot drift
 * apart.
 */
export const MIN_EFFECT_PACKAGE_SCHEMA_VERSION = 1;

/**
 * Current package schema. Version 2 adds the optional `faceDistortion`
 * component; version 1 packages (mask and/or color treatment) remain accepted
 * unchanged.
 */
export const EFFECT_PACKAGE_SCHEMA_VERSION = 2;

/** Every schema version this build accepts, in ascending order. */
export const SUPPORTED_EFFECT_PACKAGE_SCHEMA_VERSIONS = [
  MIN_EFFECT_PACKAGE_SCHEMA_VERSION,
  EFFECT_PACKAGE_SCHEMA_VERSION,
] as const;

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
  /** Reserved for a later slice; must be absent or an empty array in v1. */
  expressionReactions?: readonly unknown[];
  /** Reserved for moving parts/secondary motion; absent or empty in v1. */
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
