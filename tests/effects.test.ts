import assert from 'node:assert/strict';
import test from 'node:test';
import {
  allEffectDefinitions,
  effectOptionGroups,
  hasDistortion,
  hasMask,
  hasSecondaryMotion,
  hasTreatment,
  packageEffectDefinition,
  resolveEffect,
} from '../src/core/effects';
import type { InstalledEffectPackage } from '../src/core/effect-package-contract';

function installed(overrides: Partial<InstalledEffectPackage> = {}): InstalledEffectPackage {
  return {
    id: 'studio.guard-visor',
    name: 'Guard visor',
    version: '1.2.0',
    description: 'A rigid visor plus a cool treatment.',
    author: { name: 'Studio' },
    treatment: { saturation: 1.2, hueRotateDeg: -10 },
    distortion: null,
    secondaryMotion: null,
    mask: {
      asset: 'assets/guard-visor.glb',
      assetUrl: 'shymask://app/packages/studio.guard-visor/assets/guard-visor.glb',
      attachment: { position: [12, -7, 3], rotationDeg: [15, -30, 45], scale: 2.5 },
    },
    complexity: {
      archiveBytes: 1000,
      entryCount: 2,
      manifestBytes: 500,
      maskAssetBytes: 400,
      triangles: 96,
      meshes: 1,
      materials: 1,
      nodes: 1,
      textures: 0,
      declaredBehaviors: 0,
      colorParameters: 2,
      distortionParameters: 0,
      movingParts: 0,
    },
    importedAt: '2026-11-13T00:00:00.000Z',
    sourceFileName: 'guard-visor.zip',
    ...overrides,
  };
}

test('a package becomes one complete effect combining a mask and a color treatment', () => {
  const effect = packageEffectDefinition(installed());
  assert.equal(effect.id, 'package:studio.guard-visor');
  assert.equal(effect.label, 'Guard visor');
  assert.equal(effect.source, 'package');
  assert.equal(effect.packageVersion, '1.2.0');
  assert.equal(effect.packageRevision, '2026-11-13T00:00:00.000Z');
  assert.equal(hasMask(effect), true);
  assert.equal(hasTreatment(effect), true);
  assert.deepEqual(effect.mask, {
    kind: 'gltf',
    packageId: 'studio.guard-visor',
    assetUrl: 'shymask://app/packages/studio.guard-visor/assets/guard-visor.glb',
    attachment: { position: [12, -7, 3], rotationDeg: [15, -30, 45], scale: 2.5 },
  });
  assert.equal(effect.treatment?.cssFilter, 'saturate(1.2) hue-rotate(-10deg)');
});

test('a color-only package is a complete effect with no mask', () => {
  const effect = packageEffectDefinition(
    installed({ mask: null, treatment: { grayscale: 1 }, complexity: { ...installed().complexity, maskAssetBytes: 0, triangles: 0 } }),
  );
  assert.equal(effect.mask, null);
  assert.equal(hasMask(effect), false);
  assert.equal(hasTreatment(effect), true);
  assert.equal(effect.treatment?.cssFilter, 'grayscale(1)');
});

test('a face-distortion-only package is a complete effect with no mask or treatment', () => {
  const effect = packageEffectDefinition(
    installed({
      mask: null,
      treatment: null,
      distortion: { mode: 'bulge', strength: 0.6, radiusScale: 1.35, centerOffset: [0, 0] },
    }),
  );
  assert.equal(effect.mask, null);
  assert.equal(effect.treatment, null);
  assert.equal(hasMask(effect), false);
  assert.equal(hasTreatment(effect), false);
  assert.equal(hasDistortion(effect), true);
  assert.deepEqual(effect.distortion, {
    mode: 'bulge',
    strength: 0.6,
    radiusScale: 1.35,
    centerOffset: [0, 0],
  });
  assert.equal(hasDistortion(packageEffectDefinition(installed())), false);
});

test('a package with secondary motion keeps the declaration on the complete effect', () => {
  const secondaryMotion = {
    parts: [
      { node: 'ear-left', axis: 'y' as const, drive: 'yaw' as const, stiffness: 80, damping: 0.3, maxAngleDeg: 22, restAngleDeg: 0 },
      { node: 'hair-tuft', axis: 'x' as const, drive: 'pitch' as const, stiffness: 55, damping: 0.25, maxAngleDeg: 28, restAngleDeg: 0 },
    ],
  };
  const effect = packageEffectDefinition(installed({ treatment: null, secondaryMotion }));
  assert.equal(hasMask(effect), true);
  assert.equal(hasSecondaryMotion(effect), true);
  assert.deepEqual(effect.secondaryMotion, secondaryMotion);
  assert.equal(hasSecondaryMotion(packageEffectDefinition(installed())), false);
});

test('the bundled effects keep their ids and one-at-a-time selectable definitions', () => {
  const ids = allEffectDefinitions([]).map((effect) => effect.id);
  assert.deepEqual(ids, ['none', 'mask', 'warm', 'cool', 'mono']);
  assert.ok(allEffectDefinitions([]).every((effect) => effect.distortion === null));
  assert.ok(allEffectDefinitions([]).every((effect) => effect.secondaryMotion === null));
  assert.equal(resolveEffect('none', [])?.label, 'No effect');
  assert.equal(resolveEffect('mask', [])?.mask?.kind, 'bundled');
  assert.equal(resolveEffect('warm', [])?.treatment?.cssFilter, 'sepia(0.55) saturate(1.6) contrast(1.05) brightness(1.02)');
});

test('an unknown or stale effect id resolves to null instead of an undefined effect', () => {
  assert.equal(resolveEffect('package:removed.package', []), null);
  assert.equal(resolveEffect('not-an-effect', []), null);
});

test('the selector exposes bundled and imported groups without duplicate ids', () => {
  const groups = effectOptionGroups([installed(), installed({ id: 'studio.verdant', name: 'Verdant', mask: null })]);
  assert.deepEqual(
    groups.map((group) => group.label),
    ['Bundled effects', 'Imported packages'],
  );
  const ids = groups.flatMap((group) => group.options.map((option) => option.id));
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids.slice(0, 5), ['none', 'mask', 'warm', 'cool', 'mono']);
  assert.deepEqual(ids.slice(5), ['package:studio.guard-visor', 'package:studio.verdant']);
});
