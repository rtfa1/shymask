#!/usr/bin/env node
/**
 * Repeatable acquisition of the recorded replay fixture.
 *
 * The media bytes stay out of Git (fixtures/cache is ignored). This script
 * downloads the documented source, verifies the committed size and SHA-256,
 * and fails with an actionable message on any mismatch.
 *
 * Usage:
 *   npm run fetch:fixture            # download if missing, verify if present
 *   npm run fetch:fixture -- --force # re-download and re-verify
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const metadataPath = path.join(root, 'fixtures', 'webcam-loop.json');
const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
const fixtureDir = process.env.SHYMASK_FIXTURE_DIR
  ? path.resolve(process.env.SHYMASK_FIXTURE_DIR)
  : path.join(root, 'fixtures', 'cache');
const targetPath = path.join(fixtureDir, metadata.fileName);
const force = process.argv.includes('--force');
const userAgent = 'ShymaskFixtureFetcher/0.1 (https://github.com/rtfa1/shymask; local development)';

function sha256Of(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function describeSource() {
  return [
    `source page: ${metadata.sourcePage}`,
    `license: ${metadata.license} (${metadata.licenseUrl})`,
    `attribution: ${metadata.attribution}`,
    `expected: ${metadata.bytes} bytes, sha256 ${metadata.sha256}`,
  ].join('\n');
}

function verify(buffer) {
  const actualBytes = buffer.length;
  const actualSha256 = sha256Of(buffer);
  if (actualBytes !== metadata.bytes) {
    throw new Error(
      `Downloaded fixture size mismatch: expected ${metadata.bytes} bytes, received ${actualBytes} bytes.`,
    );
  }
  if (actualSha256 !== metadata.sha256) {
    throw new Error(
      `Downloaded fixture checksum mismatch: expected ${metadata.sha256}, received ${actualSha256}.\n` +
        'The upstream file changed or the download was corrupted. Do not use this file; ' +
        'update fixtures/webcam-loop.json only after reviewing the new source.',
    );
  }
  return { bytes: actualBytes, sha256: actualSha256 };
}

async function download(url) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': userAgent,
          Accept: 'video/webm,video/*;q=0.9,*/*;q=0.5',
        },
        redirect: 'follow',
      });
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`HTTP ${response.status} from ${url}`);
        await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
        continue;
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText} from ${url}`);
      }
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
    console.log(`Fixture already present and verified: ${targetPath}`);
    console.log(`  ${verified.bytes} bytes, sha256 ${verified.sha256}`);
    console.log('Use `npm run fetch:fixture -- --force` to re-download.');
    return;
  }

  console.log(`Fetching ${metadata.id}`);
  console.log(describeSource());
  const buffer = await download(metadata.originalUrl);
  const verified = verify(buffer);

  mkdirSync(fixtureDir, { recursive: true });
  const partialPath = `${targetPath}.partial`;
  writeFileSync(partialPath, buffer);
  renameSync(partialPath, targetPath);

  console.log(`Wrote ${targetPath}`);
  console.log(`  ${verified.bytes} bytes, sha256 ${verified.sha256} (verified)`);
}

main().catch((error) => {
  try {
    if (existsSync(`${targetPath}.partial`)) rmSync(`${targetPath}.partial`);
  } catch {
    // best-effort cleanup
  }
  console.error(`Fixture fetch failed: ${error.message}`);
  console.error(describeSource());
  console.error(
    'Fix the network/source problem and retry `npm run fetch:fixture`. The app shows an actionable paused error until a valid fixture is present.',
  );
  process.exit(1);
});
