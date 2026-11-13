import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { unzipSync, zipSync } from 'fflate';
import {
  PACKAGE_ISSUE_CODES,
  PACKAGE_SAFETY_LIMITS,
  type PackageIssueCode,
} from '../src/core/effect-package-contract';
import { validateEffectPackage, type EffectPackageValidation } from '../src/core/effect-package';
import { readZip, type ZipReadResult } from '../src/core/zip';

const PACKAGE_DIR = path.resolve(__dirname, '..', '..', 'fixtures', 'packages');
const NEGATIVE_DIR = path.join(PACKAGE_DIR, 'negative');
const FIXED_MTIME = new Date(1980, 0, 2, 12, 0, 0);

function fixtureBytes(relative: string): Uint8Array {
  return readFileSync(path.join(PACKAGE_DIR, relative));
}

function negativeBytes(name: string): Uint8Array {
  return readFileSync(path.join(NEGATIVE_DIR, `${name}.zip`));
}

function zip(files: Record<string, Uint8Array>): Uint8Array {
  return zipSync(files, { level: 6, mtime: FIXED_MTIME });
}

function guardAsset(): Uint8Array {
  const files = unzipSync(fixtureBytes('guard-visor.zip'));
  const asset = files['assets/guard-visor.glb'];
  assert.ok(asset, 'guard-visor fixture must contain its GLB');
  return asset;
}

const BASE_MANIFEST = {
  schemaVersion: 1,
  id: 'shymask.coverage',
  name: 'Coverage sample',
  version: '1.0.0',
  description: 'Synthetic package used to exercise every stable validation code.',
  author: { name: 'Coverage author' },
  mask: { asset: 'assets/mask.glb' },
} as const;

function manifestBytes(manifest: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
}

function mutateManifest(mutate: (manifest: Record<string, unknown>) => void): Uint8Array {
  const manifest = JSON.parse(JSON.stringify(BASE_MANIFEST)) as Record<string, unknown>;
  mutate(manifest);
  return zip({
    'manifest.json': manifestBytes(manifest),
    'assets/mask.glb': guardAsset(),
  });
}

function baseZip(additional: Record<string, Uint8Array> = {}): Uint8Array {
  return zip({
    'manifest.json': manifestBytes(BASE_MANIFEST),
    'assets/mask.glb': guardAsset(),
    ...additional,
  });
}

interface CentralEntry {
  headerOffset: number;
  name: string;
}

/** Locates central-directory entries so tests can craft header-only lies. */
function centralEntries(bytes: Uint8Array): CentralEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  assert.ok(eocd >= 0, 'synthetic ZIP must have an end-of-central-directory record');
  const total = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const entries: CentralEntry[] = [];
  for (let index = 0; index < total; index += 1) {
    assert.equal(view.getUint32(cursor, true), 0x02014b50, `central entry ${index} signature`);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    entries.push({ headerOffset: cursor, name });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Patches one central-directory entry in a valid synthetic ZIP. */
function patchEntry(
  bytes: Uint8Array,
  name: string,
  patch: (view: DataView, headerOffset: number) => void,
): Uint8Array {
  const copy = new Uint8Array(bytes);
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  const entry = centralEntries(copy).find((candidate) => candidate.name === name);
  assert.ok(entry, `synthetic ZIP must contain ${name}`);
  patch(view, entry.headerOffset);
  return copy;
}

type Scenario = { expected: PackageIssueCode; run: () => ZipReadResult | EffectPackageValidation };

/**
 * One executable scenario per stable code. This is the guard behind the
 * contract's "every code is covered" claim: if a code is added to
 * `PACKAGE_ISSUE_CODES` without a scenario here, the final assertion fails.
 */
function scenarios(): Scenario[] {
  const zipRead = (bytes: Uint8Array): ZipReadResult => readZip(bytes);
  const validate = (bytes: Uint8Array): EffectPackageValidation => validateEffectPackage(bytes);
  return [
    {
      expected: 'archive-too-large',
      run: () => zipRead(new Uint8Array(PACKAGE_SAFETY_LIMITS.maxArchiveBytes + 1)),
    },
    { expected: 'archive-unreadable', run: () => zipRead(new TextEncoder().encode('not a zip archive')) },
    {
      expected: 'entry-count-exceeded',
      run: () => {
        const files: Record<string, Uint8Array> = {};
        for (let index = 0; index < PACKAGE_SAFETY_LIMITS.maxEntries + 1; index += 1) {
          files[`assets/f${index}.glb`] = new Uint8Array([0]);
        }
        return zipRead(zip(files));
      },
    },
    {
      expected: 'entry-too-large',
      run: () =>
        zipRead(
          patchEntry(baseZip(), 'manifest.json', (view, headerOffset) => {
            view.setUint32(headerOffset + 24, PACKAGE_SAFETY_LIMITS.maxEntryUncompressedBytes + 1, true);
          }),
        ),
    },
    {
      expected: 'entry-too-large',
      // A committed fixture whose central directory declares 64 bytes but whose
      // deflate stream expands past the per-entry cap. Rejection without a
      // multi-megabyte allocation is the bounded-inflate guarantee.
      run: () => zipRead(negativeBytes('inflate-bomb')),
    },
    {
      expected: 'entry-compression-unsupported',
      run: () =>
        zipRead(
          patchEntry(baseZip(), 'manifest.json', (view, headerOffset) => {
            view.setUint16(headerOffset + 10, 12, true);
          }),
        ),
    },
    {
      expected: 'entry-encrypted',
      run: () =>
        zipRead(
          patchEntry(baseZip(), 'manifest.json', (view, headerOffset) => {
            view.setUint16(headerOffset + 8, 1, true);
          }),
        ),
    },
    { expected: 'entry-duplicate', run: () => zipRead(negativeBytes('duplicate-entry')) },
    {
      expected: 'entry-path-unsafe',
      run: () => zipRead(zip({ 'manifest.json': manifestBytes(BASE_MANIFEST), '../escape.glb': new Uint8Array([1]) })),
    },
    {
      expected: 'entry-path-unsafe',
      run: () => zipRead(zip({ 'manifest.json': manifestBytes(BASE_MANIFEST), '../escape/': new Uint8Array() })),
    },
    { expected: 'entry-symlink', run: () => zipRead(negativeBytes('symlink')) },
    {
      expected: 'entry-not-allowed',
      run: () => validate(baseZip({ 'notes.txt': new TextEncoder().encode('extra') })),
    },
    {
      expected: 'executable-content',
      run: () => validate(baseZip({ 'assets/evil.js': new TextEncoder().encode('process.exit(0)') })),
    },
    {
      expected: 'manifest-missing',
      run: () => validate(zip({ 'assets/mask.glb': guardAsset() })),
    },
    {
      expected: 'manifest-too-large',
      run: () => {
        const padded = `${JSON.stringify(BASE_MANIFEST)}${' '.repeat(PACKAGE_SAFETY_LIMITS.maxManifestBytes)}`;
        return validate(zip({ 'manifest.json': new TextEncoder().encode(padded), 'assets/mask.glb': guardAsset() }));
      },
    },
    {
      expected: 'manifest-not-utf8',
      run: () =>
        validate(
          zip({
            'manifest.json': new Uint8Array([0xff, 0xfe, 0xfd, 0x7b]),
            'assets/mask.glb': guardAsset(),
          }),
        ),
    },
    {
      expected: 'manifest-invalid-json',
      run: () =>
        validate(zip({ 'manifest.json': new TextEncoder().encode('{ "schemaVersion": 1,'), 'assets/mask.glb': guardAsset() })),
    },
    {
      expected: 'manifest-schema-invalid',
      run: () => validate(mutateManifest((manifest) => {
        manifest.mask = 'not an object';
      })),
    },
    {
      expected: 'schema-version-unsupported',
      run: () => validate(mutateManifest((manifest) => {
        manifest.schemaVersion = 3;
      })),
    },
    {
      expected: 'schema-version-unsupported',
      // faceDistortion is a v2 capability; a v1 declaration must not be ignored.
      run: () => validate(mutateManifest((manifest) => {
        manifest.faceDistortion = { mode: 'bulge', strength: 0.5 };
      })),
    },
    {
      expected: 'identity-invalid',
      run: () => validate(mutateManifest((manifest) => {
        manifest.name = '';
      })),
    },
    {
      expected: 'empty-effect',
      run: () => validate(mutateManifest((manifest) => {
        delete manifest.mask;
      })),
    },
    {
      expected: 'unsupported-behavior',
      run: () => validate(mutateManifest((manifest) => {
        manifest.expressionReactions = [{ type: 'blink' }];
      })),
    },
    {
      expected: 'unsupported-asset-type',
      run: () =>
        validate(
          baseZip({ 'assets/extra.gltf': new TextEncoder().encode('{"asset":{"version":"2.0"}}') }),
        ),
    },
    {
      expected: 'missing-asset',
      run: () => validate(mutateManifest((manifest) => {
        manifest.mask = { asset: 'assets/missing.glb' };
      })),
    },
    {
      expected: 'color-parameter-out-of-range',
      run: () => validate(mutateManifest((manifest) => {
        manifest.colorTreatment = { brightness: 9 };
      })),
    },
    {
      expected: 'attachment-invalid',
      run: () => validate(mutateManifest((manifest) => {
        manifest.mask = { asset: 'assets/mask.glb', attachment: { scale: 90 } };
      })),
    },
    {
      expected: 'distortion-invalid',
      run: () => validate(mutateManifest((manifest) => {
        manifest.schemaVersion = 2;
        manifest.faceDistortion = { mode: 'bulge', strength: 4 };
      })),
    },
    {
      expected: 'glb-invalid',
      run: () =>
        validate(
          zip({ 'manifest.json': manifestBytes(BASE_MANIFEST), 'assets/mask.glb': new TextEncoder().encode('not a glb') }),
        ),
    },
    { expected: 'glb-invalid', run: () => validate(negativeBytes('glb-missing-component-type')) },
    { expected: 'glb-invalid', run: () => validate(negativeBytes('glb-missing-accessor-type')) },
    { expected: 'glb-external-resource', run: () => validate(negativeBytes('external-resource')) },
    { expected: 'glb-unsupported-extension', run: () => validate(negativeBytes('unsupported-gltf-extension')) },
    { expected: 'glb-unsupported-feature', run: () => validate(negativeBytes('glb-camera')) },
    {
      expected: 'unknown-field',
      run: () => validate(mutateManifest((manifest) => {
        manifest.forwardCompatibleField = true;
      })),
    },
  ];
}

function codesOf(result: ZipReadResult | EffectPackageValidation): PackageIssueCode[] {
  if (result.ok) {
    if ('package' in result) return result.package.warnings.map((entry) => entry.code);
    return [];
  }
  if ('errors' in result) return [...result.errors, ...result.warnings].map((entry) => entry.code);
  return result.issues.map((entry) => entry.code);
}

test('every stable validation code is produced by a unit scenario or negative fixture', () => {
  const covered = new Set<PackageIssueCode>();
  for (const scenario of scenarios()) {
    const codes = codesOf(scenario.run());
    assert.ok(
      codes.includes(scenario.expected),
      `scenario must produce ${scenario.expected}, got ${codes.join(', ') || '(none)'}`,
    );
    for (const code of codes) covered.add(code);
  }
  const missing = PACKAGE_ISSUE_CODES.filter((code) => !covered.has(code));
  assert.deepEqual(
    missing,
    [],
    `these stable codes have no coverage scenario: ${missing.join(', ')}. Add a test/fixture or correct the contract claim.`,
  );
});
