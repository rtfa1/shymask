#!/usr/bin/env node
/**
 * Repeatable acquisition of the pinned MediaPipe Face Landmarker model.
 *
 * The model binary stays out of Git (.cache is ignored). The committed
 * metadata (tracker/face-landmarker-model.json) pins the source URL, license,
 * byte count and SHA-256; this script downloads into a cache and verifies them.
 * scripts/build.mjs copies a verified model into the build output; the app
 * re-validates the copy at launch and hides the output with an actionable error
 * if it is missing or corrupt.
 *
 * Usage:
 *   npm run fetch:tracker            # download if missing, verify if present
 *   npm run fetch:tracker -- --force # re-download and re-verify
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const metadataPath = path.join(root, 'tracker', 'face-landmarker-model.json');
const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
const cacheDir = path.join(root, '.cache', 'tracker');
const targetPath = path.join(cacheDir, metadata.fileName);
const force = process.argv.includes('--force');
const userAgent = 'ShymaskModelFetcher/0.1 (https://github.com/rtfa1/shymask; local development)';

function sha256Of(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function describeSource() {
  return [
    `source: ${metadata.sourceUrl}`,
    `version: ${metadata.version}`,
    `license: ${metadata.license} (${metadata.licenseUrl})`,
    `attribution: ${metadata.attribution}`,
    `expected: ${metadata.bytes} bytes, sha256 ${metadata.sha256}`,
  ].join('\n');
}

function verify(buffer) {
  const actualBytes = buffer.length;
  const actualSha256 = sha256Of(buffer);
  if (actualBytes !== metadata.bytes) {
    throw new Error(`Downloaded model size mismatch: expected ${metadata.bytes} bytes, received ${actualBytes} bytes.`);
  }
  if (actualSha256 !== metadata.sha256) {
    throw new Error(
      `Downloaded model checksum mismatch: expected ${metadata.sha256}, received ${actualSha256}. ` +
        'Do not use this file; update tracker/face-landmarker-model.json only after reviewing the upstream model.',
    );
  }
  return { bytes: actualBytes, sha256: actualSha256 };
}

async function download(url) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': userAgent, Accept: 'application/octet-stream,*/*;q=0.5' },
        redirect: 'follow',
      });
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`HTTP ${response.status} from ${url}`);
        await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText} from ${url}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function main() {
  if (existsSync(targetPath) && !force) {
    const existing = readFileSync(targetPath);
    const verified = verify(existing);
    console.log(`Face Landmarker model already present and verified: ${targetPath}`);
    console.log(`  ${verified.bytes} bytes, sha256 ${verified.sha256}`);
    console.log('Use `npm run fetch:tracker -- --force` to re-download.');
    return;
  }

  console.log(`Fetching ${metadata.id}`);
  console.log(describeSource());
  const buffer = await download(metadata.sourceUrl);
  const verified = verify(buffer);

  mkdirSync(cacheDir, { recursive: true });
  const partialPath = `${targetPath}.partial`;
  writeFileSync(partialPath, buffer);
  renameSync(partialPath, targetPath);

  console.log(`Wrote ${targetPath}`);
  console.log(`  ${verified.bytes} bytes, sha256 ${verified.sha256} (verified)`);
  console.log('Run `npm run build` (or `npm run check`) to stage the model in dist/renderer/tracker.');
}

main().catch((error) => {
  try {
    if (existsSync(`${targetPath}.partial`)) rmSync(`${targetPath}.partial`);
  } catch {
    // best-effort cleanup
  }
  console.error(`Face Landmarker model fetch failed: ${error.message}`);
  console.error(describeSource());
  console.error(
    'Fix the network/source problem and retry `npm run fetch:tracker`. Until a verified model is staged, the app hides the output and explains the missing model; it never falls back to a camera.',
  );
  process.exit(1);
});
