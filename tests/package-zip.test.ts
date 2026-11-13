import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { zipSync } from 'fflate';
import { normalizeArchivePath, readZip } from '../src/core/zip';

const PACKAGE_DIR = path.resolve(__dirname, '..', '..', 'fixtures', 'packages');
const FIXED_MTIME = new Date(1980, 0, 2, 12, 0, 0);

function zip(files: Record<string, Uint8Array>): Uint8Array {
  return zipSync(files, { level: 6, mtime: FIXED_MTIME });
}

function codes(result: ReturnType<typeof readZip>): string[] {
  return result.ok ? [] : result.issues.map((entry) => entry.code);
}

test('safe archive paths are accepted and returned as an in-memory map', () => {
  const result = readZip(
    zip({
      'manifest.json': new TextEncoder().encode('{"schemaVersion":1}'),
      'assets/mask.glb': new Uint8Array([1, 2, 3, 4]),
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.entries.map((entry) => entry.name),
    ['manifest.json', 'assets/mask.glb'],
  );
  assert.deepEqual(Array.from(result.entries[1]?.data ?? []), [1, 2, 3, 4]);
});

test('archive path normalization rejects traversal, absolutes and backslashes', () => {
  assert.equal(normalizeArchivePath('assets/mask.glb'), 'assets/mask.glb');
  for (const unsafe of [
    '../escape.glb',
    'assets/../../escape.glb',
    '/etc/passwd',
    'C:/Windows/system32/evil.glb',
    'assets\\evil.glb',
    'assets//mask.glb',
    'assets/./mask.glb',
    'assets/mask\u0000.glb',
  ]) {
    assert.equal(normalizeArchivePath(unsafe), null, `${JSON.stringify(unsafe)} must be unsafe`);
  }
});

test('an archive entry with a traversal path is rejected (zip-slip)', () => {
  const result = readZip(
    zip({
      'manifest.json': new TextEncoder().encode('{}'),
      '../escape.glb': new Uint8Array([1]),
    }),
  );
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('entry-path-unsafe'));
});

test('absolute entry paths are rejected', () => {
  const result = readZip(zip({ '/absolute.glb': new Uint8Array([1]) }));
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('entry-path-unsafe'));
});

test('symbolic links are rejected using the Unix external attributes', () => {
  const result = readZip(readFileSync(path.join(PACKAGE_DIR, 'negative', 'symlink.zip')));
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ['entry-symlink']);
});

test('duplicate entry names are rejected case-insensitively', () => {
  const result = readZip(readFileSync(path.join(PACKAGE_DIR, 'negative', 'duplicate-entry.zip')));
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ['entry-duplicate']);
  const mixedCase = readZip(
    zip({
      'assets/mask.glb': new Uint8Array([1]),
      'assets/MASK.glb': new Uint8Array([2]),
    }),
  );
  assert.equal(mixedCase.ok, false);
  assert.deepEqual(codes(mixedCase), ['entry-duplicate']);
});

test('declared oversized entries are rejected before decompression (zip-bomb guard)', () => {
  const result = readZip(readFileSync(path.join(PACKAGE_DIR, 'negative', 'oversized-entry.zip')));
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ['entry-too-large']);
});

test('too many entries and an oversized archive are rejected', () => {
  const many: Record<string, Uint8Array> = {};
  for (let index = 0; index < 65; index += 1) many[`assets/f${index}.glb`] = new Uint8Array([0]);
  const result = readZip(zip(many));
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ['entry-count-exceeded']);
  const large = readZip(new Uint8Array(8 * 1024 * 1024 + 1));
  assert.equal(large.ok, false);
  assert.deepEqual(codes(large), ['archive-too-large']);
});

test('a corrupt archive (CRC or structure) is rejected as unreadable', () => {
  const original = new Uint8Array(readFileSync(path.join(PACKAGE_DIR, 'verdant-tint.zip')));
  const localNameLength = original[26] as number;
  const localExtraLength = original[27] as number;
  const dataStart = 30 + localNameLength + localExtraLength;
  const corrupt = new Uint8Array(original);
  corrupt[dataStart + 5] = (corrupt[dataStart + 5] as number) ^ 0xff;
  const result = readZip(corrupt);
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ['archive-unreadable']);

  const truncated = original.subarray(0, original.length - 30);
  const truncatedResult = readZip(truncated);
  assert.equal(truncatedResult.ok, false);
  assert.deepEqual(codes(truncatedResult), ['archive-unreadable']);
});
