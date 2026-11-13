import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FixtureInfo, FixtureMetadata } from '../core/bridge';

export const FIXTURE_METADATA_FILENAME = 'webcam-loop.json';
export const FIXTURE_DIR_DEFAULT = path.join('fixtures', 'cache');

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const FETCH_ACTION =
  'Run `npm run fetch:fixture` from the repository root, then press Recheck input. Shymask never opens a physical webcam as a fallback.';

export interface LoadFixtureOptions {
  repoRoot: string;
  /** Directory holding the (gitignored) media file. */
  fixtureDir: string;
}

function invalid(message: string, action = FETCH_ACTION): FixtureInfo {
  return { state: 'invalid', metadata: null, message, action };
}

function validateMetadata(value: unknown): value is FixtureMetadata {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    record.id.length > 0 &&
    typeof record.title === 'string' &&
    typeof record.fileName === 'string' &&
    record.fileName.length > 0 &&
    typeof record.sourcePage === 'string' &&
    typeof record.originalUrl === 'string' &&
    typeof record.license === 'string' &&
    typeof record.licenseUrl === 'string' &&
    typeof record.attribution === 'string' &&
    typeof record.sha256 === 'string' &&
    SHA256_PATTERN.test(record.sha256) &&
    typeof record.bytes === 'number' &&
    Number.isSafeInteger(record.bytes) &&
    record.bytes > 0 &&
    typeof record.durationSeconds === 'number' &&
    record.durationSeconds > 0 &&
    typeof record.width === 'number' &&
    typeof record.height === 'number' &&
    typeof record.notes === 'string'
  );
}

function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

/**
 * Validates the recorded replay fixture before the renderer can show it.
 * Media bytes are never committed; the fetch script recreates them from the
 * documented source and verifies this same checksum.
 */
export function loadFixture({ repoRoot, fixtureDir }: LoadFixtureOptions): FixtureInfo {
  const metadataPath = path.join(repoRoot, 'fixtures', FIXTURE_METADATA_FILENAME);
  let metadata: FixtureMetadata;
  try {
    const parsed: unknown = JSON.parse(readFileSync(metadataPath, 'utf8'));
    if (!validateMetadata(parsed)) {
      return invalid(
        `Fixture metadata at ${metadataPath} is present but does not contain the required fields.`,
        'Restore fixtures/webcam-loop.json from the repository, or re-run `npm run fetch:fixture`.',
      );
    }
    metadata = parsed;
  } catch (error) {
    return invalid(
      `Fixture metadata at ${metadataPath} could not be read: ${(error as Error).message}`,
      'Restore fixtures/webcam-loop.json from the repository, or re-run `npm run fetch:fixture`.',
    );
  }

  const videoPath = path.join(fixtureDir, metadata.fileName);
  let videoBytes: number;
  try {
    videoBytes = statSync(videoPath).size;
  } catch {
    return {
      state: 'missing',
      metadata,
      message: `Replay fixture media is missing: ${videoPath}`,
      action: FETCH_ACTION,
    };
  }

  if (videoBytes !== metadata.bytes) {
    return {
      state: 'invalid',
      metadata,
      message: `Fixture size mismatch for ${videoPath}: expected ${metadata.bytes} bytes, found ${videoBytes} bytes. The cached clip is incomplete or was replaced.`,
      action: `Delete the cached clip (${videoPath}) and ${FETCH_ACTION}`,
    };
  }

  const actualSha256 = createHash('sha256').update(readFileSync(videoPath)).digest('hex');
  if (actualSha256 !== metadata.sha256) {
    return {
      state: 'invalid',
      metadata,
      message: `Fixture checksum mismatch for ${videoPath}: expected ${shortHash(metadata.sha256)}, found ${shortHash(actualSha256)}. The cached clip is corrupt or was replaced.`,
      action: `Delete the cached clip (${videoPath}) and ${FETCH_ACTION}`,
    };
  }

  return {
    state: 'ready',
    metadata,
    videoPath,
    videoUrl: pathToFileURL(videoPath).href,
  };
}
