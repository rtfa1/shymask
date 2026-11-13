/**
 * Pure, unit-testable validation for Shymask effect packages (schema v1/v2/v3).
 *
 * `validateEffectPackage` takes archive bytes and returns either a validated,
 * in-memory package (manifest + declared asset bytes + complexity measurements)
 * or structured, actionable issues. It never writes to disk, never executes
 * package content, and rejects any file that is not the manifest or a declared
 * `.glb` asset, which is what enforces ADR-0004's "declared behaviors, never
 * arbitrary executable effect code".
 *
 * See docs/effect-packages.md for the schema, the error codes and what is
 * explicitly unsupported.
 */

import {
  COLOR_PARAMETER_BOUNDS,
  DEFAULT_FACE_DISTORTION,
  DEFAULT_MASK_ATTACHMENT,
  FACE_DISTORTION_LIMITS,
  FACE_DISTORTION_MODES,
  FACE_DISTORTION_SCHEMA_VERSION,
  MASK_ATTACHMENT_LIMITS,
  PACKAGE_ASSET_PREFIX,
  PACKAGE_MANIFEST_PATH,
  PACKAGE_SAFETY_LIMITS,
  SECONDARY_MOTION_AXES,
  SECONDARY_MOTION_DRIVES,
  SECONDARY_MOTION_LIMITS,
  SECONDARY_MOTION_SCHEMA_VERSION,
  SUPPORTED_EFFECT_PACKAGE_SCHEMA_VERSIONS,
  countDeclaredColorParameters,
  type ColorTreatmentParameters,
  type EffectPackageAuthor,
  type EffectPackageManifest,
  type EffectPackageSchemaVersion,
  type FaceDistortionParameters,
  type MaskAttachment,
  type PackageComplexity,
  type PackageIssue,
  type SecondaryMotionParameters,
  type SecondaryMotionPart,
} from './effect-package-contract';
import { inspectGlb } from './glb';
import { readZip, type ZipEntry } from './zip';

export interface ValidatedEffectPackage {
  manifest: EffectPackageManifest;
  /** Archive path -> bytes, only for entries the manifest declares. */
  assets: ReadonlyMap<string, Uint8Array>;
  complexity: PackageComplexity;
  warnings: PackageIssue[];
}

export type EffectPackageValidation =
  | { ok: true; package: ValidatedEffectPackage }
  | { ok: false; errors: PackageIssue[]; warnings: PackageIssue[] };

const EXECUTABLE_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.tsx',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.sh',
  '.ps1',
  '.bat',
  '.cmd',
  '.com',
  '.py',
  '.rb',
  '.pl',
  '.php',
  '.node',
  '.wasm',
  '.html',
  '.htm',
  '.xhtml',
  '.svg',
  '.jar',
  '.class',
]);

const MANIFEST_KEYS = new Set([
  'schemaVersion',
  'id',
  'name',
  'version',
  'description',
  'author',
  'mask',
  'colorTreatment',
  'faceDistortion',
  'secondaryMotion',
  'expressionReactions',
  'behaviors',
]);
const AUTHOR_KEYS = new Set(['name', 'attribution', 'license', 'url']);
const MASK_KEYS = new Set(['asset', 'attachment']);
const ATTACHMENT_KEYS = new Set(['position', 'rotationDeg', 'scale']);
const FACE_DISTORTION_KEYS = new Set(['mode', 'strength', 'radiusScale', 'centerOffset']);
const SECONDARY_MOTION_KEYS = new Set(['parts']);
const SECONDARY_MOTION_PART_KEYS = new Set([
  'node',
  'axis',
  'drive',
  'stiffness',
  'damping',
  'maxAngleDeg',
  'restAngleDeg',
]);
const ASSET_PATH_PATTERN = /^assets\/[A-Za-z0-9][A-Za-z0-9._-]*\.glb$/;
const SECONDARY_MOTION_NODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const PACKAGE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,62}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

function issue(
  severity: PackageIssue['severity'],
  code: PackageIssue['code'],
  message: string,
  path?: string,
): PackageIssue {
  return { severity, code, message, ...(path ? { path } : {}) };
}

function error(code: PackageIssue['code'], message: string, path?: string): PackageIssue {
  return issue('error', code, message, path);
}

function warning(code: PackageIssue['code'], message: string, path?: string): PackageIssue {
  return issue('warning', code, message, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extensionOf(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot).toLowerCase() : '';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function readString(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
  issues: PackageIssue[],
  code: PackageIssue['code'] = 'identity-invalid',
): string | null {
  if (typeof value !== 'string' || value.trim().length < minimum || value.length > maximum) {
    issues.push(
      error(
        code,
        `manifest ${field} must be a string of ${minimum}-${maximum} characters.`,
        field,
      ),
    );
    return null;
  }
  return value;
}

function validateAuthor(value: unknown, issues: PackageIssue[]): EffectPackageAuthor | null {
  if (!isRecord(value)) {
    issues.push(error('identity-invalid', 'manifest author must be an object with a name.', 'author'));
    return null;
  }
  for (const key of Object.keys(value)) {
    if (!AUTHOR_KEYS.has(key)) {
      issues.push(warning('unknown-field', `Unknown author field "${key}" is ignored.`, `author.${key}`));
    }
  }
  const name = readString(value.name, 'author.name', 1, 80, issues);
  if (!name) return null;
  const author: EffectPackageAuthor = { name };
  if (value.attribution !== undefined) {
    if (typeof value.attribution !== 'string' || value.attribution.length > 200) {
      issues.push(error('identity-invalid', 'manifest author.attribution must be a string of at most 200 characters.', 'author.attribution'));
    } else {
      author.attribution = value.attribution;
    }
  }
  if (value.license !== undefined) {
    if (typeof value.license !== 'string' || value.license.length > 40) {
      issues.push(error('identity-invalid', 'manifest author.license must be a string of at most 40 characters.', 'author.license'));
    } else {
      author.license = value.license;
    }
  }
  if (value.url !== undefined) {
    if (typeof value.url !== 'string' || value.url.length > 300 || !/^https?:\/\//.test(value.url)) {
      issues.push(error('identity-invalid', 'manifest author.url must be an http(s) URL.', 'author.url'));
    } else {
      author.url = value.url;
    }
  }
  return author;
}

interface AttachmentResult {
  attachment: MaskAttachment | null;
  issues: PackageIssue[];
}

function readVec3(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
  issues: PackageIssue[],
): readonly [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) {
    issues.push(error('attachment-invalid', `${field} must be an array of three numbers.`, field));
    return null;
  }
  const numbers: number[] = [];
  for (const [index, item] of value.entries()) {
    if (!isFiniteNumber(item) || item < minimum || item > maximum) {
      issues.push(
        error(
          'attachment-invalid',
          `${field}[${index}] must be a finite number between ${minimum} and ${maximum}.`,
          `${field}[${index}]`,
        ),
      );
      return null;
    }
    numbers.push(item);
  }
  return [numbers[0] as number, numbers[1] as number, numbers[2] as number];
}

function validateAttachment(value: unknown): AttachmentResult {
  const issues: PackageIssue[] = [];
  if (value === undefined) {
    return { attachment: { ...DEFAULT_MASK_ATTACHMENT }, issues };
  }
  if (!isRecord(value)) {
    issues.push(error('attachment-invalid', 'manifest mask.attachment must be an object.', 'mask.attachment'));
    return { attachment: null, issues };
  }
  for (const key of Object.keys(value)) {
    if (!ATTACHMENT_KEYS.has(key)) {
      issues.push(
        error(
          'attachment-invalid',
          `Unknown mask.attachment field "${key}". Supported fields: position, rotationDeg, scale.`,
          `mask.attachment.${key}`,
        ),
      );
    }
  }
  const position =
    value.position === undefined
      ? DEFAULT_MASK_ATTACHMENT.position
      : readVec3(
          value.position,
          'mask.attachment.position',
          -MASK_ATTACHMENT_LIMITS.maxPositionCm,
          MASK_ATTACHMENT_LIMITS.maxPositionCm,
          issues,
        );
  const rotationDeg =
    value.rotationDeg === undefined
      ? DEFAULT_MASK_ATTACHMENT.rotationDeg
      : readVec3(
          value.rotationDeg,
          'mask.attachment.rotationDeg',
          -MASK_ATTACHMENT_LIMITS.maxRotationDeg,
          MASK_ATTACHMENT_LIMITS.maxRotationDeg,
          issues,
        );
  let scale = DEFAULT_MASK_ATTACHMENT.scale;
  if (value.scale !== undefined) {
    if (
      !isFiniteNumber(value.scale) ||
      value.scale < MASK_ATTACHMENT_LIMITS.minScale ||
      value.scale > MASK_ATTACHMENT_LIMITS.maxScale
    ) {
      issues.push(
        error(
          'attachment-invalid',
          `mask.attachment.scale must be a finite number between ${MASK_ATTACHMENT_LIMITS.minScale} and ${MASK_ATTACHMENT_LIMITS.maxScale}.`,
          'mask.attachment.scale',
        ),
      );
      scale = DEFAULT_MASK_ATTACHMENT.scale;
    } else {
      scale = value.scale;
    }
  }
  if (!position || !rotationDeg) return { attachment: null, issues };
  return { attachment: { position, rotationDeg, scale }, issues };
}

function validateColorTreatment(value: unknown): { treatment: ColorTreatmentParameters | null; issues: PackageIssue[] } {
  const issues: PackageIssue[] = [];
  if (!isRecord(value)) {
    issues.push(
      error(
        'manifest-schema-invalid',
        'manifest colorTreatment must be an object of bounded parameters (brightness, contrast, saturation, hueRotateDeg, sepia, grayscale).',
        'colorTreatment',
      ),
    );
    return { treatment: null, issues };
  }
  const known = new Set(COLOR_PARAMETER_BOUNDS.map((bound) => bound.key as string));
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      issues.push(
        error(
          'manifest-schema-invalid',
          `Unknown colorTreatment parameter "${key}". Supported parameters: ${[...known].join(', ')}.`,
          `colorTreatment.${key}`,
        ),
      );
    }
  }
  const treatment: ColorTreatmentParameters = {};
  for (const bound of COLOR_PARAMETER_BOUNDS) {
    const raw = value[bound.key];
    if (raw === undefined) continue;
    if (!isFiniteNumber(raw) || raw < bound.min || raw > bound.max) {
      issues.push(
        error(
          'color-parameter-out-of-range',
          `colorTreatment.${bound.key} must be a number between ${bound.min} and ${bound.max}; got ${JSON.stringify(raw)}.`,
          `colorTreatment.${bound.key}`,
        ),
      );
      continue;
    }
    treatment[bound.key] = raw;
  }
  if (Object.keys(treatment).length === 0 && issues.length === 0) {
    issues.push(
      error(
        'manifest-schema-invalid',
        'colorTreatment must declare at least one bounded parameter.',
        'colorTreatment',
      ),
    );
  }
  return { treatment, issues };
}

function validateFaceDistortion(value: unknown): {
  distortion: FaceDistortionParameters | null;
  issues: PackageIssue[];
} {
  const issues: PackageIssue[] = [];
  if (!isRecord(value)) {
    issues.push(
      error(
        'distortion-invalid',
        'manifest faceDistortion must be an object with a supported mode ("bulge" or "pinch") and a bounded strength.',
        'faceDistortion',
      ),
    );
    return { distortion: null, issues };
  }
  for (const key of Object.keys(value)) {
    if (!FACE_DISTORTION_KEYS.has(key)) {
      issues.push(
        error(
          'distortion-invalid',
          `Unknown faceDistortion field "${key}". Supported fields: mode, strength, radiusScale, centerOffset.`,
          `faceDistortion.${key}`,
        ),
      );
    }
  }
  const mode = value.mode;
  if (typeof mode !== 'string' || !(FACE_DISTORTION_MODES as readonly string[]).includes(mode)) {
    issues.push(
      error(
        'distortion-invalid',
        `faceDistortion.mode must be one of ${FACE_DISTORTION_MODES.map((entry) => `"${entry}"`).join(', ')}; got ${JSON.stringify(mode)}.`,
        'faceDistortion.mode',
      ),
    );
  }
  const rawStrength = value.strength;
  let strength: number = FACE_DISTORTION_LIMITS.minStrength;
  if (
    !isFiniteNumber(rawStrength) ||
    rawStrength < FACE_DISTORTION_LIMITS.minStrength ||
    rawStrength > FACE_DISTORTION_LIMITS.maxStrength
  ) {
    issues.push(
      error(
        'distortion-invalid',
        `faceDistortion.strength must be a finite number between ${FACE_DISTORTION_LIMITS.minStrength} and ${FACE_DISTORTION_LIMITS.maxStrength}; got ${JSON.stringify(rawStrength)}.`,
        'faceDistortion.strength',
      ),
    );
  } else {
    strength = rawStrength;
  }
  let radiusScale: number = DEFAULT_FACE_DISTORTION.radiusScale;
  if (value.radiusScale !== undefined) {
    if (
      !isFiniteNumber(value.radiusScale) ||
      value.radiusScale < FACE_DISTORTION_LIMITS.minRadiusScale ||
      value.radiusScale > FACE_DISTORTION_LIMITS.maxRadiusScale
    ) {
      issues.push(
        error(
          'distortion-invalid',
          `faceDistortion.radiusScale must be a finite number between ${FACE_DISTORTION_LIMITS.minRadiusScale} and ${FACE_DISTORTION_LIMITS.maxRadiusScale}; got ${JSON.stringify(value.radiusScale)}.`,
          'faceDistortion.radiusScale',
        ),
      );
    } else {
      radiusScale = value.radiusScale;
    }
  }
  let centerOffset = DEFAULT_FACE_DISTORTION.centerOffset;
  if (value.centerOffset !== undefined) {
    const parsed = readVec2(
      value.centerOffset,
      'faceDistortion.centerOffset',
      -FACE_DISTORTION_LIMITS.maxCenterOffset,
      FACE_DISTORTION_LIMITS.maxCenterOffset,
      issues,
    );
    if (parsed) centerOffset = parsed;
  }
  if (issues.length > 0) return { distortion: null, issues };
  return {
    distortion: {
      mode: mode as FaceDistortionParameters['mode'],
      strength,
      radiusScale,
      centerOffset,
    },
    issues,
  };
}

/** Reads a bounded two-number point (used only by faceDistortion.centerOffset). */
function readVec2(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
  issues: PackageIssue[],
): readonly [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) {
    issues.push(error('distortion-invalid', `${field} must be an array of two numbers.`, field));
    return null;
  }
  const numbers: number[] = [];
  for (const [index, item] of value.entries()) {
    if (!isFiniteNumber(item) || item < minimum || item > maximum) {
      issues.push(
        error(
          'distortion-invalid',
          `${field}[${index}] must be a finite number between ${minimum} and ${maximum}; got ${JSON.stringify(item)}.`,
          `${field}[${index}]`,
        ),
      );
      return null;
    }
    numbers.push(item);
  }
  return [numbers[0] as number, numbers[1] as number];
}

function validateSecondaryMotion(
  value: unknown,
  hasMask: boolean,
): { secondaryMotion: SecondaryMotionParameters | null; issues: PackageIssue[] } {
  const issues: PackageIssue[] = [];
  const fail = (message: string, path: string): void => {
    issues.push(error('secondary-motion-invalid', message, path));
  };
  if (!isRecord(value)) {
    fail(
      'manifest secondaryMotion must be an object with a parts array of named mask nodes and bounded spring parameters.',
      'secondaryMotion',
    );
    return { secondaryMotion: null, issues };
  }
  for (const key of Object.keys(value)) {
    if (!SECONDARY_MOTION_KEYS.has(key)) {
      fail(
        `Unknown secondaryMotion field "${key}". Supported fields: parts.`,
        `secondaryMotion.${key}`,
      );
    }
  }
  const rawParts = value.parts;
  if (!Array.isArray(rawParts)) {
    fail('secondaryMotion.parts must be an array of 1-4 movable part declarations.', 'secondaryMotion.parts');
    return { secondaryMotion: null, issues };
  }
  if (rawParts.length < 1 || rawParts.length > SECONDARY_MOTION_LIMITS.maxParts) {
    fail(
      `secondaryMotion.parts must declare between 1 and ${SECONDARY_MOTION_LIMITS.maxParts} parts; got ${rawParts.length}.`,
      'secondaryMotion.parts',
    );
  }
  if (!hasMask) {
    fail(
      'secondaryMotion requires a "mask" component: movable parts are named nodes of the package mask GLB.',
      'secondaryMotion',
    );
  }
  const seenNodes = new Set<string>();
  const parts: SecondaryMotionPart[] = [];
  for (const [index, rawPart] of rawParts.entries()) {
    const field = `secondaryMotion.parts[${index}]`;
    if (!isRecord(rawPart)) {
      fail(`${field} must be an object with node, axis, drive, stiffness, damping and maxAngleDeg.`, field);
      continue;
    }
    for (const key of Object.keys(rawPart)) {
      if (!SECONDARY_MOTION_PART_KEYS.has(key)) {
        fail(
          `Unknown ${field} field "${key}". Supported fields: node, axis, drive, stiffness, damping, maxAngleDeg, restAngleDeg.`,
          `${field}.${key}`,
        );
      }
    }
    const node = rawPart.node;
    if (
      typeof node !== 'string' ||
      node.length > SECONDARY_MOTION_LIMITS.maxNodeNameLength ||
      !SECONDARY_MOTION_NODE_PATTERN.test(node)
    ) {
      fail(
        `${field}.node must be a mask GLB node name of 1-${SECONDARY_MOTION_LIMITS.maxNodeNameLength} characters: an ASCII letter or digit first, then only letters, digits, "_" or "-"; got ${JSON.stringify(node)}.`,
        `${field}.node`,
      );
    } else if (seenNodes.has(node)) {
      fail(`${field}.node "${node}" is declared more than once; each movable part needs a distinct node.`, `${field}.node`);
    } else {
      seenNodes.add(node);
    }
    const axis = rawPart.axis;
    if (typeof axis !== 'string' || !(SECONDARY_MOTION_AXES as readonly string[]).includes(axis)) {
      fail(
        `${field}.axis must be one of ${SECONDARY_MOTION_AXES.map((entry) => `"${entry}"`).join(', ')}; got ${JSON.stringify(axis)}.`,
        `${field}.axis`,
      );
    }
    const drive = rawPart.drive;
    if (typeof drive !== 'string' || !(SECONDARY_MOTION_DRIVES as readonly string[]).includes(drive)) {
      fail(
        `${field}.drive must be one of ${SECONDARY_MOTION_DRIVES.map((entry) => `"${entry}"`).join(', ')} (the tracked head rotation that drives the part); got ${JSON.stringify(drive)}.`,
        `${field}.drive`,
      );
    }
    const boundedNumber = (
      raw: unknown,
      name: string,
      minimum: number,
      maximum: number,
      defaultValue?: number,
    ): number => {
      if (raw === undefined && defaultValue !== undefined) return defaultValue;
      if (!isFiniteNumber(raw) || raw < minimum || raw > maximum) {
        fail(
          `${field}.${name} must be a finite number between ${minimum} and ${maximum}; got ${JSON.stringify(raw)}.`,
          `${field}.${name}`,
        );
        return defaultValue ?? minimum;
      }
      return raw;
    };
    const stiffness = boundedNumber(
      rawPart.stiffness,
      'stiffness',
      SECONDARY_MOTION_LIMITS.minStiffness,
      SECONDARY_MOTION_LIMITS.maxStiffness,
    );
    const damping = boundedNumber(
      rawPart.damping,
      'damping',
      SECONDARY_MOTION_LIMITS.minDampingRatio,
      SECONDARY_MOTION_LIMITS.maxDampingRatio,
    );
    const maxAngleDeg = boundedNumber(
      rawPart.maxAngleDeg,
      'maxAngleDeg',
      SECONDARY_MOTION_LIMITS.minMaxAngleDeg,
      SECONDARY_MOTION_LIMITS.maxMaxAngleDeg,
    );
    const restAngleDeg = boundedNumber(
      rawPart.restAngleDeg,
      'restAngleDeg',
      -SECONDARY_MOTION_LIMITS.maxRestAngleDeg,
      SECONDARY_MOTION_LIMITS.maxRestAngleDeg,
      0,
    );
    if (Math.abs(restAngleDeg) > maxAngleDeg) {
      fail(
        `${field}.restAngleDeg must be within the declared maxAngleDeg (${maxAngleDeg}); got ${restAngleDeg}.`,
        `${field}.restAngleDeg`,
      );
    }
    if (
      typeof node === 'string' &&
      SECONDARY_MOTION_NODE_PATTERN.test(node) &&
      typeof axis === 'string' &&
      typeof drive === 'string'
    ) {
      parts.push({
        node,
        axis: axis as SecondaryMotionParameters['parts'][number]['axis'],
        drive: drive as SecondaryMotionParameters['parts'][number]['drive'],
        stiffness,
        damping,
        maxAngleDeg,
        restAngleDeg,
      });
    }
  }
  if (issues.length > 0) return { secondaryMotion: null, issues };
  return { secondaryMotion: { parts }, issues };
}

function validateMask(value: unknown): {
  mask: { asset: string; attachment: MaskAttachment } | null;
  issues: PackageIssue[];
} {
  const issues: PackageIssue[] = [];
  if (!isRecord(value)) {
    issues.push(error('manifest-schema-invalid', 'manifest mask must be an object with an asset path.', 'mask'));
    return { mask: null, issues };
  }
  for (const key of Object.keys(value)) {
    if (!MASK_KEYS.has(key)) {
      issues.push(
        error(
          'manifest-schema-invalid',
          `Unknown mask field "${key}". Supported fields: asset, attachment.`,
          `mask.${key}`,
        ),
      );
    }
  }
  if (typeof value.asset !== 'string' || value.asset.length > 128) {
    issues.push(
      error('missing-asset', 'manifest mask.asset must be an archive path such as "assets/mask.glb".', 'mask.asset'),
    );
    return { mask: null, issues };
  }
  if (!ASSET_PATH_PATTERN.test(value.asset)) {
    issues.push(
      error(
        'missing-asset',
        `mask.asset "${value.asset}" must be a single-level path under assets/ ending in .glb (for example "assets/mask.glb").`,
        'mask.asset',
      ),
    );
    return { mask: null, issues };
  }
  const attachment = validateAttachment(value.attachment);
  issues.push(...attachment.issues);
  if (!attachment.attachment) return { mask: null, issues };
  return { mask: { asset: value.asset, attachment: attachment.attachment }, issues };
}

function validateEntryPaths(entries: ZipEntry[]): PackageIssue[] {
  const issues: PackageIssue[] = [];
  for (const entry of entries) {
    if (entry.name === PACKAGE_MANIFEST_PATH) continue;
    const extension = extensionOf(entry.name);
    if (EXECUTABLE_EXTENSIONS.has(extension)) {
      issues.push(
        error(
          'executable-content',
          `Archive entry "${entry.name}" is executable or script content (${extension}), which effect packages must never contain.`,
          entry.name,
        ),
      );
      continue;
    }
    if (!entry.name.startsWith(PACKAGE_ASSET_PREFIX)) {
      issues.push(
        error(
          'entry-not-allowed',
          `Archive entry "${entry.name}" is not allowed. A package contains only manifest.json and declared assets under assets/.`,
          entry.name,
        ),
      );
      continue;
    }
    if (!ASSET_PATH_PATTERN.test(entry.name)) {
      issues.push(
        error(
          'unsupported-asset-type',
          `Asset "${entry.name}" is not supported. v1 accepts only a single .glb file directly under assets/ (for example assets/mask.glb).`,
          entry.name,
        ),
      );
    }
  }
  return issues;
}

/** Parses/validates the manifest JSON. Returns issues and a typed manifest. */
function validateManifestObject(value: unknown, issues: PackageIssue[], warnings: PackageIssue[]): EffectPackageManifest | null {
  if (!isRecord(value)) {
    issues.push(error('manifest-schema-invalid', 'manifest.json must contain a JSON object.'));
    return null;
  }
  for (const key of Object.keys(value)) {
    if (!MANIFEST_KEYS.has(key)) {
      warnings.push(warning('unknown-field', `Unknown manifest field "${key}" is ignored by this schema.`, key));
    }
  }
  const schemaVersion =
    typeof value.schemaVersion === 'number' &&
    (SUPPORTED_EFFECT_PACKAGE_SCHEMA_VERSIONS as readonly number[]).includes(value.schemaVersion)
      ? (value.schemaVersion as EffectPackageSchemaVersion)
      : null;
  if (schemaVersion === null) {
    issues.push(
      error(
        'schema-version-unsupported',
        `schemaVersion ${JSON.stringify(value.schemaVersion)} is not supported. This build reads effect package schema versions ${describeSchemaVersions()}.`,
        'schemaVersion',
      ),
    );
  }
  // A v1 manifest declaring faceDistortion is rejected, not silently ignored:
  // a v1-only build would accept the package, warn about an unknown field, and
  // drop the declared distortion.
  if (value.faceDistortion !== undefined && schemaVersion !== null && schemaVersion < FACE_DISTORTION_SCHEMA_VERSION) {
    issues.push(
      error(
        'schema-version-unsupported',
        `faceDistortion requires schemaVersion ${FACE_DISTORTION_SCHEMA_VERSION}; this manifest declares schemaVersion ${schemaVersion}. Raise schemaVersion or remove the distortion declaration.`,
        'faceDistortion',
      ),
    );
  }
  // Likewise, a lower-version build would ignore secondary motion and render a
  // rigid mask, so the declaration requires the version that understands it.
  if (value.secondaryMotion !== undefined && schemaVersion !== null && schemaVersion < SECONDARY_MOTION_SCHEMA_VERSION) {
    issues.push(
      error(
        'schema-version-unsupported',
        `secondaryMotion requires schemaVersion ${SECONDARY_MOTION_SCHEMA_VERSION}; this manifest declares schemaVersion ${schemaVersion}. Raise schemaVersion or remove the moving-part declaration.`,
        'secondaryMotion',
      ),
    );
  }
  const id =
    typeof value.id === 'string' && PACKAGE_ID_PATTERN.test(value.id)
      ? value.id
      : null;
  if (!id) {
    issues.push(
      error(
        'identity-invalid',
        'manifest id must be 2-63 characters of lowercase letters, digits, dots, underscores or hyphens (for example "studio.guard-visor").',
        'id',
      ),
    );
  }
  const name = readString(value.name, 'name', 1, 80, issues);
  const version =
    typeof value.version === 'string' && VERSION_PATTERN.test(value.version)
      ? value.version
      : null;
  if (!version) {
    issues.push(error('identity-invalid', 'manifest version must be a semantic version such as "1.0.0".', 'version'));
  }
  const description = readString(value.description, 'description', 1, 500, issues, 'manifest-schema-invalid');
  const author = validateAuthor(value.author, issues);

  for (const reserved of ['expressionReactions', 'behaviors'] as const) {
    const declared = value[reserved];
    if (declared === undefined) continue;
    if (!Array.isArray(declared)) {
      issues.push(
        error('manifest-schema-invalid', `manifest ${reserved} must be an array (reserved and empty in v1).`, reserved),
      );
      continue;
    }
    if (declared.length > 0) {
      issues.push(
        error(
          'unsupported-behavior',
          `manifest ${reserved} declares ${declared.length} behavior(s), which this schema version does not support. Remove the declaration or use a package without it; unsupported behavior is rejected rather than ignored.`,
          reserved,
        ),
      );
    }
  }

  let mask: { asset: string; attachment: MaskAttachment } | null = null;
  if (value.mask !== undefined) {
    const parsed = validateMask(value.mask);
    issues.push(...parsed.issues);
    mask = parsed.mask;
  }
  let treatment: ColorTreatmentParameters | null = null;
  if (value.colorTreatment !== undefined) {
    const parsed = validateColorTreatment(value.colorTreatment);
    issues.push(...parsed.issues);
    treatment = parsed.treatment;
  }
  let distortion: FaceDistortionParameters | null = null;
  if (value.faceDistortion !== undefined && schemaVersion !== null && schemaVersion >= FACE_DISTORTION_SCHEMA_VERSION) {
    const parsed = validateFaceDistortion(value.faceDistortion);
    issues.push(...parsed.issues);
    distortion = parsed.distortion;
  }
  let secondaryMotion: SecondaryMotionParameters | null = null;
  if (
    value.secondaryMotion !== undefined &&
    schemaVersion !== null &&
    schemaVersion >= SECONDARY_MOTION_SCHEMA_VERSION
  ) {
    const parsed = validateSecondaryMotion(value.secondaryMotion, mask !== null);
    issues.push(...parsed.issues);
    secondaryMotion = parsed.secondaryMotion;
  }
  if (value.mask === undefined && value.colorTreatment === undefined && value.faceDistortion === undefined) {
    issues.push(
      error(
        'empty-effect',
        'The package declares no effect. Add a "mask" component, a "colorTreatment" component, a "faceDistortion" component, or a combination to make one complete effect.',
      ),
    );
  }

  if (issues.length > 0) return null;
  return {
    schemaVersion: schemaVersion as EffectPackageSchemaVersion,
    id: id as string,
    name: name as string,
    version: version as string,
    description: description as string,
    author: author as EffectPackageAuthor,
    ...(mask ? { mask: { asset: mask.asset, attachment: mask.attachment } } : {}),
    ...(treatment ? { colorTreatment: treatment } : {}),
    ...(distortion ? { faceDistortion: distortion } : {}),
    ...(secondaryMotion ? { secondaryMotion } : {}),
  };
}

function describeSchemaVersions(): string {
  const versions = SUPPORTED_EFFECT_PACKAGE_SCHEMA_VERSIONS;
  if (versions.length <= 1) return versions.join('');
  return `${versions.slice(0, -1).join(', ')} and ${versions[versions.length - 1]}`;
}

export function validateEffectPackage(bytes: Uint8Array): EffectPackageValidation {
  const zip = readZip(bytes);
  if (!zip.ok) {
    return { ok: false, errors: zip.issues, warnings: [] };
  }
  const entries = zip.entries;
  const warnings: PackageIssue[] = [];
  const errors: PackageIssue[] = validateEntryPaths(entries);

  const manifestEntry = entries.find((entry) => entry.name === PACKAGE_MANIFEST_PATH);
  if (!manifestEntry) {
    errors.push(
      error(
        'manifest-missing',
        'The archive has no root manifest.json. Add a schema manifest at the archive root (not inside a folder).',
      ),
    );
    return { ok: false, errors, warnings };
  }
  if (manifestEntry.data.length > PACKAGE_SAFETY_LIMITS.maxManifestBytes) {
    errors.push(
      error(
        'manifest-too-large',
        `manifest.json is ${manifestEntry.data.length} bytes; the safety limit is ${PACKAGE_SAFETY_LIMITS.maxManifestBytes}.`,
      ),
    );
    return { ok: false, errors, warnings };
  }
  let manifestText: string;
  try {
    manifestText = new TextDecoder('utf-8', { fatal: true }).decode(manifestEntry.data);
  } catch {
    errors.push(error('manifest-not-utf8', 'manifest.json is not valid UTF-8. Save it as UTF-8 JSON.'));
    return { ok: false, errors, warnings };
  }
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(manifestText.replace(/^\uFEFF/u, ''));
  } catch (cause) {
    errors.push(
      error('manifest-invalid-json', `manifest.json is not valid JSON: ${(cause as Error).message}`),
    );
    return { ok: false, errors, warnings };
  }

  const manifest = validateManifestObject(rawManifest, errors, warnings);
  if (!manifest) {
    return { ok: false, errors, warnings };
  }

  const declaredAssets = new Set<string>();
  if (manifest.mask) declaredAssets.add(manifest.mask.asset);
  for (const entry of entries) {
    if (entry.name === PACKAGE_MANIFEST_PATH || declaredAssets.has(entry.name)) continue;
    if (errors.some((existing) => existing.path === entry.name)) continue;
    errors.push(
      error(
        'entry-not-allowed',
        `Archive entry "${entry.name}" is not declared by manifest.json. Packages may contain only the manifest and the declared mask asset.`,
        entry.name,
      ),
    );
  }

  const assets = new Map<string, Uint8Array>();
  let triangles = 0;
  let meshes = 0;
  let materials = 0;
  let nodes = 0;
  let textures = 0;
  let maskAssetBytes = 0;
  if (manifest.mask) {
    const asset = entries.find((entry) => entry.name === manifest.mask?.asset);
    if (!asset) {
      errors.push(
        error(
          'missing-asset',
          `The manifest declares mask asset "${manifest.mask.asset}" but the archive does not contain it.`,
          manifest.mask.asset,
        ),
      );
    } else if (asset.data.length > PACKAGE_SAFETY_LIMITS.maxMaskAssetBytes) {
      errors.push(
        error(
          'entry-too-large',
          `Mask asset "${asset.name}" is ${asset.data.length} bytes; the safety limit is ${PACKAGE_SAFETY_LIMITS.maxMaskAssetBytes}.`,
          asset.name,
        ),
      );
    } else {
      const glb = inspectGlb(asset.data);
      if (!glb.ok) {
        for (const glbIssue of glb.issues) errors.push({ ...glbIssue, path: asset.name });
      } else {
        assets.set(asset.name, asset.data);
        maskAssetBytes = asset.data.length;
        triangles = glb.summary.triangles;
        meshes = glb.summary.meshes;
        materials = glb.summary.materials;
        nodes = glb.summary.nodes;
        textures = glb.summary.textures;
        // A declared movable part must resolve to exactly one named GLB node.
        // Checking it here (not at selection) keeps a typo an import error with
        // an actionable message instead of an unanimated mask at runtime.
        if (manifest.secondaryMotion) {
          for (const [partIndex, part] of manifest.secondaryMotion.parts.entries()) {
            const matches = glb.summary.nodeNames.filter((name) => name === part.node).length;
            if (matches !== 1) {
              errors.push(
                error(
                  'secondary-motion-invalid',
                  `secondaryMotion.parts[${partIndex}].node "${part.node}" must name exactly one node in the mask GLB "${asset.name}"; found ${matches}. Rename the part or the GLB node.`,
                  `secondaryMotion.parts[${partIndex}].node`,
                ),
              );
            }
          }
        }
      }
    }
  }

  const declaredBehaviors =
    (Array.isArray((rawManifest as Record<string, unknown>).expressionReactions)
      ? ((rawManifest as Record<string, unknown>).expressionReactions as unknown[]).length
      : 0) +
    (Array.isArray((rawManifest as Record<string, unknown>).behaviors)
      ? ((rawManifest as Record<string, unknown>).behaviors as unknown[]).length
      : 0);

  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }

  const complexity: PackageComplexity = {
    archiveBytes: bytes.length,
    entryCount: entries.length,
    manifestBytes: manifestEntry.data.length,
    maskAssetBytes,
    triangles,
    meshes,
    materials,
    nodes,
    textures,
    declaredBehaviors,
    colorParameters: manifest.colorTreatment ? countDeclaredColorParameters(manifest.colorTreatment) : 0,
    distortionParameters: manifest.faceDistortion ? 1 : 0,
    movingParts: manifest.secondaryMotion ? manifest.secondaryMotion.parts.length : 0,
  };
  return { ok: true, package: { manifest, assets, complexity, warnings } };
}
