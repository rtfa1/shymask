import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EffectPackageStore } from '../src/main/effect-packages';

const FIXTURES = path.resolve(__dirname, '..', '..', 'fixtures', 'packages');

function temporaryStore(): { root: string; store: EffectPackageStore; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'shymask-store-'));
  return {
    root,
    store: new EffectPackageStore(root, 'shymask://app/packages'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('list removes crash-leftover import directories and does not rewrite unchanged assets', (t) => {
  const { root, store, cleanup } = temporaryStore();
  t.after(cleanup);
  // Simulate a crash-leftover temp directory from a previous run, then let the
  // first store operation (the list call inside importArchive) clean it.
  const staleTemp = path.join(root, '.import-1234-crash');
  mkdirSync(staleTemp, { recursive: true });
  writeFileSync(path.join(staleTemp, 'package.zip'), 'leftover');
  const imported = store.importArchive(path.join(FIXTURES, 'guard-visor.zip'));
  assert.equal(imported.status, 'imported', imported.message);
  assert.equal(statSync(staleTemp, { throwIfNoEntry: false }), undefined, 'crash-leftover temp directory must be removed');

  const assetPath = path.join(root, 'shymask.guard-visor', 'assets', 'guard-visor.glb');
  const assetBytes = readFileSync(assetPath);
  const mtimeBefore = statSync(assetPath).mtimeMs;

  const list = store.list();
  assert.equal(list.packages.length, 1);
  assert.equal(statSync(assetPath).mtimeMs, mtimeBefore, 'an unchanged asset must not be rewritten');
  assert.deepEqual(readFileSync(assetPath), assetBytes);
});

test('list repairs a tampered extracted asset from the revalidated archive', (t) => {
  const { root, store, cleanup } = temporaryStore();
  t.after(cleanup);
  const imported = store.importArchive(path.join(FIXTURES, 'guard-visor.zip'));
  assert.equal(imported.status, 'imported', imported.message);
  const assetPath = path.join(root, 'shymask.guard-visor', 'assets', 'guard-visor.glb');
  const expected = readFileSync(assetPath);
  writeFileSync(assetPath, 'tampered');

  const list = store.list();
  assert.equal(list.packages.length, 1);
  assert.deepEqual(readFileSync(assetPath), expected, 'tampered assets must be restored from the validated archive');
});
