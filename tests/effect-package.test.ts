import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { unzipSync, zipSync } from 'fflate';
import {
  buildTreatmentCssFilter,
  EFFECT_PACKAGE_SCHEMA_VERSION,
  type PackageIssueCode,
} from '../src/core/effect-package-contract';
import { validateEffectPackage } from '../src/core/effect-package';

const PACKAGE_DIR = path.resolve(__dirname, '..', '..', 'fixtures', 'packages');
const NEGATIVE_DIR = path.join(PACKAGE_DIR, 'negative');
const FIXED_MTIME = new Date(1980, 0, 2, 12, 0, 0);

function fixtureBytes(relative: string): Uint8Array {
  return readFileSync(path.join(PACKAGE_DIR, relative));
}

function negativeBytes(name: string): Uint8Array {
  return readFileSync(path.join(NEGATIVE_DIR, `${name}.zip`));
}

/** Rebuilds a package with a mutated manifest, for schema cases. */
function mutateManifest(
  source: Uint8Array,
  mutate: (manifest: Record<string, unknown>) => void,
): Uint8Array {
  const files = unzipSync(source);
  const manifestFile = files['manifest.json'];
  assert.ok(manifestFile, 'fixture must contain manifest.json');
  const manifest = JSON.parse(new TextDecoder().decode(manifestFile)) as Record<string, unknown>;
  mutate(manifest);
  files['manifest.json'] = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  return zipSync(files, { level: 6, mtime: FIXED_MTIME });
}

function expectError(bytes: Uint8Array, code: PackageIssueCode): void {
  const result = validateEffectPackage(bytes);
  assert.equal(result.ok, false, `expected validation to fail with ${code}`);
  if (result.ok) return;
  const codes = result.errors.map((entry) => entry.code);
  assert.ok(codes.includes(code), `expected ${code}, got ${codes.join(', ')}: ${result.errors.map((entry) => entry.message).join(' | ')}`);
  for (const entry of result.errors) {
    assert.ok(entry.message.length > 20, `validation message must be actionable: ${entry.message}`);
  }
}

test('the valid sample mask package validates and reports complexity measurements', () => {
  const result = validateEffectPackage(fixtureBytes('guard-visor.zip'));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const pkg = result.package;
  assert.equal(pkg.manifest.schemaVersion, EFFECT_PACKAGE_SCHEMA_VERSION);
  assert.equal(pkg.manifest.id, 'shymask.guard-visor');
  assert.equal(pkg.manifest.name, 'Guard visor');
  assert.equal(pkg.manifest.version, '1.0.0');
  assert.ok(pkg.manifest.mask);
  assert.equal(pkg.manifest.mask?.asset, 'assets/guard-visor.glb');
  assert.deepEqual(pkg.manifest.mask?.attachment?.position, [0, 0, 0]);
  assert.equal(pkg.manifest.colorTreatment?.saturation, 1.15);
  assert.equal(pkg.assets.size, 1);
  assert.ok(pkg.assets.get('assets/guard-visor.glb'));
  assert.equal(pkg.complexity.triangles, 96);
  assert.equal(pkg.complexity.meshes, 1);
  assert.equal(pkg.complexity.materials, 1);
  assert.equal(pkg.complexity.colorParameters, 3);
  assert.equal(pkg.complexity.declaredBehaviors, 0);
  assert.deepEqual(pkg.warnings, []);
  assert.equal(
    buildTreatmentCssFilter(pkg.manifest.colorTreatment ?? {}),
    'contrast(1.05) saturate(1.15) hue-rotate(-8deg)',
  );
});

test('the valid sample color-only package validates without a mask', () => {
  const result = validateEffectPackage(fixtureBytes('verdant-tint.zip'));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.package.manifest.mask, undefined);
  assert.ok(result.package.manifest.colorTreatment);
  assert.equal(result.package.assets.size, 0);
  assert.equal(result.package.complexity.triangles, 0);
  assert.equal(result.package.complexity.colorParameters, 4);
});

test('an unsupported schemaVersion is rejected with the supported version named', () => {
  const result = validateEffectPackage(negativeBytes('schema-version-2'));
  assert.equal(result.ok, false);
  if (result.ok) return;
  const issue = result.errors.find((entry) => entry.code === 'schema-version-unsupported');
  assert.ok(issue);
  assert.match(issue.message, /schema version 1/);
});

test('malformed manifest JSON is rejected as actionable JSON feedback', () => {
  expectError(negativeBytes('malformed-json'), 'manifest-invalid-json');
});

test('a missing manifest, empty effect and missing asset are rejected', () => {
  expectError(negativeBytes('manifest-missing'), 'manifest-missing');
  expectError(negativeBytes('empty-effect'), 'empty-effect');
  expectError(negativeBytes('missing-asset'), 'missing-asset');
});

test('declared but unsupported behaviors are rejected instead of ignored', () => {
  expectError(negativeBytes('unsupported-behavior'), 'unsupported-behavior');
  expectError(negativeBytes('gltf-animation'), 'unsupported-behavior');
});

test('color parameters outside their bounded ranges are rejected', () => {
  expectError(negativeBytes('invalid-color'), 'color-parameter-out-of-range');
  // Direct mutation keeps the bounds covered independently of the fixture.
  const bytes = mutateManifest(fixtureBytes('guard-visor.zip'), (manifest) => {
    const treatment = manifest.colorTreatment as Record<string, unknown>;
    treatment.brightness = 3;
  });
  expectError(bytes, 'color-parameter-out-of-range');
});

test('mask attachment values are bounded and unknown fields are actionable', () => {
  const outOfRange = mutateManifest(fixtureBytes('guard-visor.zip'), (manifest) => {
    const mask = manifest.mask as { attachment: Record<string, unknown> };
    mask.attachment.scale = 90;
  });
  expectError(outOfRange, 'attachment-invalid');
  const unknownAttachment = mutateManifest(fixtureBytes('guard-visor.zip'), (manifest) => {
    const mask = manifest.mask as { attachment: Record<string, unknown> };
    mask.attachment.spin = 1;
  });
  expectError(unknownAttachment, 'attachment-invalid');
});

test('unknown top-level manifest fields are warnings, not silent acceptance of behavior', () => {
  const bytes = mutateManifest(fixtureBytes('verdant-tint.zip'), (manifest) => {
    manifest.note = 'forward-compatible field';
  });
  const result = validateEffectPackage(bytes);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.package.warnings.some((entry) => entry.code === 'unknown-field'));
});

test('executable and script content is rejected before anything is extracted', () => {
  expectError(negativeBytes('executable-file'), 'executable-content');
});

test('unsupported asset types are rejected with the supported GLB form named', () => {
  expectError(negativeBytes('unsupported-asset-type'), 'unsupported-asset-type');
});

test('GLB external resources, required extensions and unsupported features are rejected', () => {
  expectError(negativeBytes('external-resource'), 'glb-external-resource');
  expectError(negativeBytes('unsupported-gltf-extension'), 'glb-unsupported-extension');
});

test('a non-ZIP file and an oversized archive produce actionable archive errors', () => {
  expectError(new TextEncoder().encode('this is not a zip archive at all'), 'archive-unreadable');
  expectError(new Uint8Array(8 * 1024 * 1024 + 1), 'archive-too-large');
});
