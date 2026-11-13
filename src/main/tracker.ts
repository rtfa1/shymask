import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { TrackerInfo, TrackerMetadata } from '../core/bridge';

export const TRACKER_METADATA_FILENAME = 'face-landmarker-model.json';
export const TRACKER_METADATA_DIR = 'tracker';

/** Runtime files copied from @mediapipe/tasks-vision by scripts/build.mjs. */
export const REQUIRED_TRACKER_FILES = [
  'face_landmarker.task',
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
] as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MODEL_ACTION =
  'Run `npm run fetch:tracker` (downloads and verifies the pinned model), then `npm run build` and restart Shymask. The output stays hidden; Shymask never opens a physical camera as a fallback.';

export interface LoadTrackerOptions {
  repoRoot: string;
  /** Directory holding the model and WASM files inside the build output. */
  trackerDir: string;
  /** Base URL the renderer passes to FilesetResolver, without a trailing slash. */
  wasmBaseUrl?: string;
}

function invalid(message: string, action = MODEL_ACTION): TrackerInfo {
  return { state: 'invalid', metadata: null, message, action };
}

function validateMetadata(value: unknown): value is TrackerMetadata {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    record.id.length > 0 &&
    typeof record.version === 'string' &&
    typeof record.fileName === 'string' &&
    record.fileName.length > 0 &&
    typeof record.sourceUrl === 'string' &&
    typeof record.license === 'string' &&
    typeof record.licenseUrl === 'string' &&
    typeof record.attribution === 'string' &&
    typeof record.sha256 === 'string' &&
    SHA256_PATTERN.test(record.sha256) &&
    typeof record.bytes === 'number' &&
    Number.isSafeInteger(record.bytes) &&
    record.bytes > 0 &&
    typeof record.notes === 'string'
  );
}

/**
 * Validates the local face-tracker assets before the renderer tries to load
 * them. A missing or corrupt model is an actionable, hidden-output error; it is
 * never silently skipped and there is no camera fallback anywhere in this path.
 */
export function loadTracker({ repoRoot, trackerDir, wasmBaseUrl = 'shymask://app/tracker' }: LoadTrackerOptions): TrackerInfo {
  const metadataPath = path.join(repoRoot, TRACKER_METADATA_DIR, TRACKER_METADATA_FILENAME);
  let metadata: TrackerMetadata;
  try {
    const parsed: unknown = JSON.parse(readFileSync(metadataPath, 'utf8'));
    if (!validateMetadata(parsed)) {
      return invalid(
        `Face-tracker metadata at ${metadataPath} is present but does not contain the required fields.`,
        'Restore tracker/face-landmarker-model.json from the repository, then run `npm run fetch:tracker` and restart the app.',
      );
    }
    metadata = parsed;
  } catch (error) {
    return invalid(
      `Face-tracker metadata at ${metadataPath} could not be read: ${(error as Error).message}`,
      'Restore tracker/face-landmarker-model.json from the repository, then run `npm run fetch:tracker` and restart the app.',
    );
  }

  const missing: string[] = REQUIRED_TRACKER_FILES.filter((fileName) => {
    const file = path.join(trackerDir, fileName);
    return !existsSync(file) || statSync(file).size === 0;
  });
  if (missing.length > 0) {
    if (missing.includes(metadata.fileName)) {
      return {
        state: 'missing',
        metadata,
        message: `The face-tracker model is missing: ${path.join(trackerDir, metadata.fileName)}.`,
        action: MODEL_ACTION,
      };
    }
    return invalid(
      `The face-tracker runtime files are missing: ${missing.join(', ')} in ${trackerDir}. Reinstall dependencies and run \`npm run build\`.`,
    );
  }

  const modelPath = path.join(trackerDir, metadata.fileName);
  const bytes = statSync(modelPath).size;
  if (bytes !== metadata.bytes) {
    return {
      state: 'invalid',
      metadata,
      message: `Face-tracker model size mismatch for ${modelPath}: expected ${metadata.bytes} bytes, found ${bytes} bytes.`,
      action: MODEL_ACTION,
    };
  }
  const actualSha256 = createHash('sha256').update(readFileSync(modelPath)).digest('hex');
  if (actualSha256 !== metadata.sha256) {
    return {
      state: 'invalid',
      metadata,
      message: `Face-tracker model checksum mismatch for ${modelPath}: expected ${metadata.sha256.slice(0, 12)}…, found ${actualSha256.slice(0, 12)}….`,
      action: MODEL_ACTION,
    };
  }

  return {
    state: 'ready',
    metadata,
    wasmBaseUrl,
    modelUrl: `${wasmBaseUrl}/${metadata.fileName}`,
  };
}
