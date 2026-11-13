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
  // v1 packages remain valid unchanged under the v2-aware validator.
  assert.equal(pkg.manifest.schemaVersion, 1);
  assert.equal(pkg.manifest.id, 'shymask.guard-visor');
  assert.equal(pkg.manifest.name, 'Guard visor');
  assert.equal(pkg.manifest.version, '1.0.0');
  assert.ok(pkg.manifest.mask);
  assert.equal(pkg.manifest.mask?.asset, 'assets/guard-visor.glb');
  assert.deepEqual(pkg.manifest.mask?.attachment?.position, [0, 0, 0]);
  assert.equal(pkg.manifest.colorTreatment?.saturation, 1.15);
  assert.equal(pkg.manifest.faceDistortion, undefined);
  assert.equal(pkg.assets.size, 1);
  assert.ok(pkg.assets.get('assets/guard-visor.glb'));
  assert.equal(pkg.complexity.triangles, 96);
  assert.equal(pkg.complexity.meshes, 1);
  assert.equal(pkg.complexity.materials, 1);
  assert.equal(pkg.complexity.colorParameters, 3);
  assert.equal(pkg.complexity.distortionParameters, 0);
  assert.equal(pkg.complexity.declaredBehaviors, 0);
  assert.deepEqual(pkg.warnings, []);
  assert.equal(
    buildTreatmentCssFilter(pkg.manifest.colorTreatment ?? {}),
    'contrast(1.05) saturate(1.15) hue-rotate(-8deg)',
  );
});

test('the schema v2 face-distortion sample validates without a mask or treatment', () => {
  const result = validateEffectPackage(fixtureBytes('face-distortion.zip'));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const pkg = result.package;
  assert.equal(pkg.manifest.schemaVersion, 2);
  assert.equal(pkg.manifest.id, 'shymask.face-distortion');
  assert.equal(pkg.manifest.mask, undefined);
  assert.equal(pkg.manifest.colorTreatment, undefined);
  assert.deepEqual(pkg.manifest.faceDistortion, {
    mode: 'bulge',
    strength: 0.6,
    radiusScale: 1.35,
    centerOffset: [0, 0],
  });
  assert.equal(pkg.complexity.distortionParameters, 1);
  assert.equal(pkg.complexity.colorParameters, 0);
  assert.equal(pkg.complexity.triangles, 0);
  assert.deepEqual(pkg.warnings, []);
});

test('faceDistortion optional fields resolve to bounded defaults', () => {
  const bytes = mutateManifest(fixtureBytes('face-distortion.zip'), (manifest) => {
    manifest.faceDistortion = { mode: 'pinch', strength: 0.25 };
  });
  const result = validateEffectPackage(bytes);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.package.manifest.faceDistortion, {
    mode: 'pinch',
    strength: 0.25,
    radiusScale: 1,
    centerOffset: [0, 0],
  });
});

test('a v1 manifest declaring faceDistortion is rejected instead of silently dropping it', () => {
  const bytes = mutateManifest(fixtureBytes('face-distortion.zip'), (manifest) => {
    manifest.schemaVersion = 1;
  });
  const result = validateEffectPackage(bytes);
  assert.equal(result.ok, false);
  if (result.ok) return;
  const issue = result.errors.find((entry) => entry.code === 'schema-version-unsupported');
  assert.ok(issue, `expected schema-version-unsupported, got ${result.errors.map((entry) => entry.code).join(', ')}`);
  assert.equal(issue.path, 'faceDistortion');
  assert.match(issue.message, /requires schemaVersion 2/);
});

test('invalid or unsupported face-distortion declarations are rejected with distortion-invalid', () => {
  const cases: Array<{ name: string; mutate: (distortion: Record<string, unknown>) => void }> = [
    { name: 'unsupported mode', mutate: (distortion) => { distortion.mode = 'twist'; } },
    { name: 'strength above the bound', mutate: (distortion) => { distortion.strength = 4; } },
    { name: 'non-finite strength', mutate: (distortion) => { distortion.strength = Number.POSITIVE_INFINITY; } },
    { name: 'radiusScale below the bound', mutate: (distortion) => { distortion.radiusScale = 0; } },
    { name: 'centerOffset out of range', mutate: (distortion) => { distortion.centerOffset = [2, 0]; } },
    { name: 'centerOffset wrong shape', mutate: (distortion) => { distortion.centerOffset = [0, 0, 0]; } },
    { name: 'unknown field', mutate: (distortion) => { distortion.swirl = 1; } },
  ];
  for (const entry of cases) {
    const bytes = mutateManifest(fixtureBytes('face-distortion.zip'), (manifest) => {
      const distortion = manifest.faceDistortion as Record<string, unknown>;
      entry.mutate(distortion);
    });
    const result = validateEffectPackage(bytes);
    assert.equal(result.ok, false, `${entry.name} must be rejected`);
    if (result.ok) continue;
    const issue = result.errors.find((candidate) => candidate.code === 'distortion-invalid');
    assert.ok(
      issue,
      `${entry.name} must report distortion-invalid, got ${result.errors.map((candidate) => candidate.code).join(', ')}`,
    );
    assert.ok(issue.message.length > 20, `${entry.name}: message must be actionable: ${issue.message}`);
    assert.ok(issue.path?.startsWith('faceDistortion'), `${entry.name}: issue path must name the field, got ${issue.path}`);
  }
});

test('schema v2 accepts a mask without faceDistortion, keeping v1 effects forward-compatible', () => {
  const bytes = mutateManifest(fixtureBytes('guard-visor.zip'), (manifest) => {
    manifest.schemaVersion = 2;
  });
  const result = validateEffectPackage(bytes);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.package.manifest.schemaVersion, 2);
  assert.equal(result.package.manifest.faceDistortion, undefined);
  assert.ok(result.package.manifest.mask);
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

test('an unsupported schemaVersion is rejected with the supported versions named', () => {
  const result = validateEffectPackage(negativeBytes('schema-version-4'));
  assert.equal(result.ok, false);
  if (result.ok) return;
  const issue = result.errors.find((entry) => entry.code === 'schema-version-unsupported');
  assert.ok(issue);
  assert.match(issue.message, /schema versions 1, 2 and 3/);
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

test('a GLB accessor missing componentType or type is rejected at import, not at selection', () => {
  for (const name of ['glb-missing-component-type', 'glb-missing-accessor-type']) {
    const result = validateEffectPackage(negativeBytes(name));
    assert.equal(result.ok, false, `${name} must be rejected at import`);
    if (result.ok) continue;
    const issue = result.errors.find((entry) => entry.code === 'glb-invalid');
    assert.ok(issue, `${name} must report glb-invalid, got ${result.errors.map((entry) => entry.code).join(', ')}`);
    assert.equal(issue.path, 'assets/guard-visor.glb');
    assert.match(issue.message, /componentType|type/);
  }
});

test('a GLB camera is rejected as an unsupported feature at import', () => {
  const result = validateEffectPackage(negativeBytes('glb-camera'));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((entry) => entry.code === 'glb-unsupported-feature'));
});

test('the schema v3 secondary-motion sample validates its named moving parts', () => {
  const result = validateEffectPackage(fixtureBytes('reactive-ears.zip'));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const pkg = result.package;
  assert.equal(pkg.manifest.schemaVersion, EFFECT_PACKAGE_SCHEMA_VERSION);
  assert.equal(pkg.manifest.schemaVersion, 3);
  assert.equal(pkg.manifest.id, 'shymask.reactive-ears');
  assert.ok(pkg.manifest.mask);
  assert.equal(pkg.manifest.mask?.asset, 'assets/reactive-ears.glb');
  assert.equal(pkg.manifest.secondaryMotion?.parts.length, 3);
  assert.deepEqual(
    pkg.manifest.secondaryMotion?.parts.map((part) => `${part.node}:${part.axis}:${part.drive}:${part.maxAngleDeg}`),
    ['ear-left:y:yaw:32', 'ear-right:y:yaw:32', 'hair-tuft:x:pitch:35'],
  );
  assert.equal(pkg.complexity.movingParts, 3);
  assert.equal(pkg.complexity.triangles, 204);
  assert.equal(pkg.complexity.meshes, 4);
  assert.equal(pkg.complexity.nodes, 4);
});

test('secondaryMotion is rejected in a lower schema version instead of silently rendering a rigid mask', () => {
  const bytes = mutateManifest(fixtureBytes('reactive-ears.zip'), (manifest) => {
    manifest.schemaVersion = 2;
  });
  const result = validateEffectPackage(bytes);
  assert.equal(result.ok, false);
  if (result.ok) return;
  const issue = result.errors.find((entry) => entry.code === 'schema-version-unsupported');
  assert.ok(issue, `expected schema-version-unsupported, got ${result.errors.map((entry) => entry.code).join(', ')}`);
  assert.equal(issue.path, 'secondaryMotion');
  assert.match(issue.message, /requires schemaVersion 3/);
});

test('schema v3 accepts a mask without secondaryMotion, keeping v1/v2 effects forward-compatible', () => {
  const bytes = mutateManifest(fixtureBytes('guard-visor.zip'), (manifest) => {
    manifest.schemaVersion = 3;
  });
  const result = validateEffectPackage(bytes);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.package.manifest.schemaVersion, 3);
  assert.equal(result.package.manifest.secondaryMotion, undefined);
  assert.equal(result.package.complexity.movingParts, 0);
});

test('invalid secondary-motion declarations are rejected with secondary-motion-invalid', () => {
  const cases: Array<{ name: string; mutate: (parts: Array<Record<string, unknown>>, manifest: Record<string, unknown>) => void }> = [
    { name: 'unsupported axis', mutate: (parts) => { parts[0]!.axis = 'w'; } },
    { name: 'unsupported drive', mutate: (parts) => { parts[0]!.drive = 'tilt'; } },
    { name: 'stiffness out of range', mutate: (parts) => { parts[0]!.stiffness = 4000; } },
    { name: 'damping out of range', mutate: (parts) => { parts[0]!.damping = 9; } },
    { name: 'maxAngleDeg out of range', mutate: (parts) => { parts[0]!.maxAngleDeg = 90; } },
    { name: 'restAngleDeg beyond maxAngleDeg', mutate: (parts) => { parts[0]!.restAngleDeg = 40; } },
    { name: 'unknown node', mutate: (parts) => { parts[0]!.node = 'left-ear'; } },
    { name: 'duplicate node', mutate: (parts) => { parts[1]!.node = parts[0]!.node; } },
    { name: 'unknown field', mutate: (parts) => { parts[0]!.gravity = 1; } },
    { name: 'too many parts', mutate: (parts) => { parts.push(...parts.slice(0, 2).map((part, index) => ({ ...part, node: `extra-${index}` }))); } },
    { name: 'no mask', mutate: (_parts, manifest) => { delete manifest.mask; } },
    { name: 'empty parts', mutate: (_parts, manifest) => { manifest.secondaryMotion = { parts: [] }; } },
  ];
  for (const entry of cases) {
    const bytes = mutateManifest(fixtureBytes('reactive-ears.zip'), (manifest) => {
      const declaration = manifest.secondaryMotion as { parts: Array<Record<string, unknown>> };
      entry.mutate(declaration.parts, manifest);
    });
    const result = validateEffectPackage(bytes);
    assert.equal(result.ok, false, `${entry.name} must be rejected`);
    if (result.ok) continue;
    const issue = result.errors.find((candidate) => candidate.code === 'secondary-motion-invalid');
    assert.ok(
      issue,
      `${entry.name} must report secondary-motion-invalid, got ${result.errors.map((candidate) => candidate.code).join(', ')}`,
    );
    assert.ok(issue.message.length > 20, `${entry.name}: message must be actionable: ${issue.message}`);
    assert.ok(issue.path?.startsWith('secondaryMotion'), `${entry.name}: issue path must name the field, got ${issue.path}`);
  }
});

test('the committed secondary-motion negative fixtures are rejected with actionable codes', () => {
  expectError(negativeBytes('secondary-motion-schema-v2'), 'schema-version-unsupported');
  for (const name of [
    'secondary-motion-invalid-axis',
    'secondary-motion-unknown-node',
    'secondary-motion-out-of-range',
    'secondary-motion-unknown-field',
    'secondary-motion-rest-beyond-max',
    'secondary-motion-without-mask',
  ]) {
    expectError(negativeBytes(name), 'secondary-motion-invalid');
  }
});

test('nonzero mask attachment position, rotation and scale survive validation', () => {
  const bytes = mutateManifest(fixtureBytes('guard-visor.zip'), (manifest) => {
    const mask = manifest.mask as { attachment: Record<string, unknown> };
    mask.attachment = { position: [12, -7, 3], rotationDeg: [15, -30, 45], scale: 2.5 };
  });
  const result = validateEffectPackage(bytes);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.package.manifest.mask?.attachment, {
    position: [12, -7, 3],
    rotationDeg: [15, -30, 45],
    scale: 2.5,
  });
});
