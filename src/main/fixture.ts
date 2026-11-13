import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FixtureInfo, FixtureMetadata } from '../core/bridge';

export const FIXTURE_METADATA_FILENAME = 'webcam-loop.json';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export interface LoadFixtureOptions {
  repoRoot: string;
  /** Directory holding the (gitignored) media file. */
  fixtureDir: string;
  /**
   * Manifest filename under `fixtures/`, or an absolute/relative path. The
   * default recorded replay is `webcam-loop.json`; the public-workflow check
   * selects the larger-motion clip through `SHYMASK_FIXTURE_MANIFEST`.
   */
  metadataFileName?: string;
  /**
   * Builds the URL the renderer hands to the <video> element. The app uses the
   * local asset protocol; the default keeps this module usable outside Electron.
   */
  videoUrlForFile?: (fileName: string) => string;
  /** Recovery command named in missing/invalid explanations. */
  fetchCommand?: string;
}

function metadataPathFor(repoRoot: string, fileName: string): string {
  if (path.isAbsolute(fileName)) return fileName;
  if (fileName.includes('/') || fileName.includes('\\')) return path.resolve(repoRoot, fileName);
  return path.join(repoRoot, 'fixtures', fileName);
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
export function loadFixture({
  repoRoot,
  fixtureDir,
  metadataFileName = FIXTURE_METADATA_FILENAME,
  videoUrlForFile = (fileName) => pathToFileURL(fileName).href,
  fetchCommand = 'npm run fetch:fixture',
}: LoadFixtureOptions): FixtureInfo {
  const metadataPath = metadataPathFor(repoRoot, metadataFileName);
  const fetchAction = `Run \`${fetchCommand}\` from the repository root, then press Recheck input. Shymask never opens a physical webcam as a fallback.`;
  const invalid = (message: string, action = fetchAction): FixtureInfo => ({
    state: 'invalid',
    metadata: null,
    message,
    action,
  });

  let metadata: FixtureMetadata;
  try {
    const parsed: unknown = JSON.parse(readFileSync(metadataPath, 'utf8'));
    if (!validateMetadata(parsed)) {
      return invalid(
        `Fixture metadata at ${metadataPath} is present but does not contain the required fields.`,
        'Restore the fixture manifest from the repository, or re-run the documented fetch command.',
      );
    }
    metadata = parsed;
  } catch (error) {
    return invalid(
      `Fixture metadata at ${metadataPath} could not be read: ${(error as Error).message}`,
      'Restore the fixture manifest from the repository, or re-run the documented fetch command.',
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
      action: fetchAction,
    };
  }

  if (videoBytes !== metadata.bytes) {
    return {
      state: 'invalid',
      metadata,
      message: `Fixture size mismatch for ${videoPath}: expected ${metadata.bytes} bytes, found ${videoBytes} bytes. The cached clip is incomplete or was replaced.`,
      action: `Delete the cached clip (${videoPath}) and ${fetchAction}`,
    };
  }

  const actualSha256 = createHash('sha256').update(readFileSync(videoPath)).digest('hex');
  if (actualSha256 !== metadata.sha256) {
    return {
      state: 'invalid',
      metadata,
      message: `Fixture checksum mismatch for ${videoPath}: expected ${shortHash(metadata.sha256)}, found ${shortHash(actualSha256)}. The cached clip is corrupt or was replaced.`,
      action: `Delete the cached clip (${videoPath}) and ${fetchAction}`,
    };
  }

  return {
    state: 'ready',
    metadata,
    videoUrl: videoUrlForFile(metadata.fileName),
  };
}
