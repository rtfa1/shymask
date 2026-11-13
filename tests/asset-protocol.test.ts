import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createAssetHandler,
  createAssetResponse,
  resolveAssetPath,
  type AssetRoots,
} from '../src/main/asset-protocol';

const CLIP_BYTES = Buffer.from('0123456789');

interface Fixture {
  dir: string;
  roots: AssetRoots;
  clipPath: string;
  cleanup: () => void;
}

function makeFixture(clipBytes: Buffer = CLIP_BYTES): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), 'shymask-assets-'));
  const roots: AssetRoots = {
    rendererDir: path.join(dir, 'renderer'),
    trackerDir: path.join(dir, 'tracker'),
    fixtureDir: path.join(dir, 'fixture'),
    packageDir: path.join(dir, 'packages'),
  };
  for (const root of Object.values(roots)) mkdirSync(root, { recursive: true });
  const clipPath = path.join(roots.fixtureDir, 'clip.webm');
  writeFileSync(clipPath, clipBytes);
  writeFileSync(path.join(roots.rendererDir, 'index.html'), '<!doctype html>');
  writeFileSync(path.join(roots.trackerDir, 'face_landmarker.task'), Buffer.from('model'));
  return {
    dir,
    roots,
    clipPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function clipAsset(fixture: Fixture) {
  const asset = resolveAssetPath(fixture.roots, '/fixture/clip.webm');
  assert.ok(asset, 'the fixture clip must resolve through the protocol');
  return asset;
}

function request(headers: Record<string, string> = {}, method = 'GET'): Request {
  return new Request('shymask://app/fixture/clip.webm', { method, headers });
}

async function bodyText(response: Response): Promise<string> {
  return Buffer.from(await response.arrayBuffer()).toString('utf8');
}

test('a plain request without a range returns the whole asset', async (t) => {
  const fixture = makeFixture();
  t.after(fixture.cleanup);
  const response = createAssetResponse(clipAsset(fixture), request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(response.headers.get('content-length'), String(CLIP_BYTES.length));
  assert.equal(response.headers.get('content-type'), 'video/webm');
  assert.equal(await bodyText(response), '0123456789');
});

test('a closed byte range returns exactly that inclusive slice', async (t) => {
  const fixture = makeFixture();
  t.after(fixture.cleanup);
  const response = createAssetResponse(clipAsset(fixture), request({ range: 'bytes=2-5' }));
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(response.headers.get('content-length'), '4');
  assert.equal(await bodyText(response), '2345');
});

test('a suffix range returns the last N bytes', async (t) => {
  const fixture = makeFixture();
  t.after(fixture.cleanup);
  const response = createAssetResponse(clipAsset(fixture), request({ range: 'bytes=-3' }));
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 7-9/10');
  assert.equal(await bodyText(response), '789');
  // A suffix longer than the file is clamped to the whole file.
  const whole = createAssetResponse(clipAsset(fixture), request({ range: 'bytes=-999' }));
  assert.equal(whole.status, 206);
  assert.equal(whole.headers.get('content-range'), 'bytes 0-9/10');
  assert.equal(await bodyText(whole), '0123456789');
});

test('an oversized end is clamped to the last byte instead of rejected', async (t) => {
  const fixture = makeFixture();
  t.after(fixture.cleanup);
  const response = createAssetResponse(clipAsset(fixture), request({ range: 'bytes=8-99999' }));
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 8-9/10');
  assert.equal(await bodyText(response), '89');
  const fromStart = createAssetResponse(clipAsset(fixture), request({ range: 'bytes=0-99999' }));
  assert.equal(fromStart.status, 206);
  assert.equal(fromStart.headers.get('content-range'), 'bytes 0-9/10');
});

test('an open-ended range returns the rest of the asset', async (t) => {
  const fixture = makeFixture();
  t.after(fixture.cleanup);
  const response = createAssetResponse(clipAsset(fixture), request({ range: 'bytes=4-' }));
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 4-9/10');
  assert.equal(await bodyText(response), '456789');
});

test('unsatisfiable ranges return 416 and no content', async (t) => {
  const fixture = makeFixture();
  t.after(fixture.cleanup);
  for (const range of ['bytes=-0', 'bytes=10-', 'bytes=5-2', 'bytes=-']) {
    const response = createAssetResponse(clipAsset(fixture), request({ range }));
    assert.equal(response.status, 416, `range ${range} must be unsatisfiable`);
    assert.equal(response.headers.get('content-range'), 'bytes */10');
    assert.equal(response.body, null);
  }
});

test('an empty file rejects any range and serves an empty body otherwise', async (t) => {
  const fixture = makeFixture(Buffer.alloc(0));
  t.after(fixture.cleanup);
  const ranged = createAssetResponse(clipAsset(fixture), request({ range: 'bytes=0-' }));
  assert.equal(ranged.status, 416);
  assert.equal(ranged.headers.get('content-range'), 'bytes */0');
  const plain = createAssetResponse(clipAsset(fixture), request());
  assert.equal(plain.status, 200);
  assert.equal(await bodyText(plain), '');
});

test('a HEAD request reports the asset size without a body', async (t) => {
  const fixture = makeFixture();
  t.after(fixture.cleanup);
  const response = createAssetResponse(clipAsset(fixture), request({}, 'HEAD'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), String(CLIP_BYTES.length));
  assert.equal(response.headers.get('content-type'), 'video/webm');
  assert.equal(response.body, null);
});

test('an unrecognised or multi-part range is ignored and the whole asset is served', async (t) => {
  const fixture = makeFixture();
  t.after(fixture.cleanup);
  for (const range of ['items=0-1', 'bytes=0-1,3-4', 'bytes=abc']) {
    const response = createAssetResponse(clipAsset(fixture), request({ range }));
    assert.equal(response.status, 200, `range ${range} must be ignored`);
    assert.equal(await bodyText(response), '0123456789');
  }
});

test('directory traversal cannot leave a configured root', () => {
  const fixture = makeFixture();
  try {
    assert.equal(resolveAssetPath(fixture.roots, '/../secret.webm'), null);
    assert.equal(resolveAssetPath(fixture.roots, '/fixture/../../secret.webm'), null);
    assert.equal(resolveAssetPath(fixture.roots, '/fixture/%2e%2e/secret.webm'), null);
    assert.equal(resolveAssetPath(fixture.roots, '/fixture/'), null);
    assert.equal(resolveAssetPath(fixture.roots, '/fixture/missing.webm'), null);
  } finally {
    fixture.cleanup();
  }
});

test('a symlink inside a root still resolves when it stays inside that root', (t) => {
  const fixture = makeFixture();
  const innerDir = path.join(fixture.roots.fixtureDir, 'inner');
  mkdirSync(innerDir);
  writeFileSync(path.join(innerDir, 'inside.webm'), 'inner');
  const linkPath = path.join(fixture.roots.fixtureDir, 'link');
  try {
    symlinkSync(innerDir, linkPath, 'junction');
  } catch (error) {
    fixture.cleanup();
    t.skip(`cannot create a directory junction on this host: ${(error as Error).message}`);
    return;
  }
  t.after(() => {
    try {
      rmdirSync(linkPath);
    } catch {
      // Best-effort link removal; the temp tree is removed below.
    }
    fixture.cleanup();
  });
  const asset = resolveAssetPath(fixture.roots, '/fixture/link/inside.webm');
  assert.ok(asset, 'an in-root link must not be rejected');
  assert.equal(asset.file, realpathSync(path.join(innerDir, 'inside.webm')));
});

test('a symlink that escapes a root is rejected by the realpath containment check', (t) => {
  const fixture = makeFixture();
  const outsideDir = path.join(fixture.dir, 'outside');
  mkdirSync(outsideDir);
  const secretPath = path.join(outsideDir, 'secret.webm');
  writeFileSync(secretPath, 'secret');
  const linkPath = path.join(fixture.roots.fixtureDir, 'escape');
  try {
    symlinkSync(outsideDir, linkPath, 'junction');
  } catch (error) {
    fixture.cleanup();
    t.skip(`cannot create a directory junction on this host: ${(error as Error).message}`);
    return;
  }
  t.after(() => {
    try {
      rmdirSync(linkPath);
    } catch {
      // Best-effort link removal; the temp tree is removed below.
    }
    fixture.cleanup();
  });
  assert.equal(resolveAssetPath(fixture.roots, '/fixture/escape/secret.webm'), null);
});

test('the handler rejects another host and unknown routes', () => {
  const fixture = makeFixture();
  try {
    const handler = createAssetHandler(fixture.roots);
    assert.equal(handler(new Request('shymask://other/fixture/clip.webm')).status, 404);
    assert.equal(handler(new Request('shymask://app/fixture/missing.webm')).status, 404);
    const served = handler(new Request('shymask://app/fixture/clip.webm'));
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'video/webm');
  } finally {
    fixture.cleanup();
  }
});
