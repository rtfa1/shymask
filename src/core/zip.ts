/**
 * Minimal, safety-checked ZIP reader for effect packages.
 *
 * We deliberately do not hand extracted paths to a general-purpose extractor.
 * This reader parses the central directory first, rejects unsafe names
 * (traversal, absolute paths, backslashes, control characters), symlink and
 * encryption entries, unsupported compression and ZIP64 before inflating, and
 * enforces the package safety caps on *declared* sizes before decompression.
 * Inflating a deflate entry is itself bounded: fflate writes into a
 * preallocated `cap + 1` byte output buffer that it never resizes, so a central
 * directory that lies about its size still cannot allocate unbounded memory;
 * output past the cap is rejected as `entry-too-large`. Accepted entries are
 * then size- and CRC-verified.
 *
 * Nothing is ever written to disk here: the validators return an in-memory
 * name->bytes map, and the main process extracts only the entries a validated
 * manifest explicitly declares.
 */

import { inflateSync } from 'fflate';
import type { PackageIssue } from './effect-package-contract';
import { PACKAGE_SAFETY_LIMITS } from './effect-package-contract';

export interface ZipEntry {
  /** Archive-relative path, exactly as stored (already proven safe). */
  name: string;
  data: Uint8Array;
  method: 0 | 8;
  compressedBytes: number;
  uncompressedBytes: number;
}

export type ZipReadResult =
  | { ok: true; entries: ZipEntry[] }
  | { ok: false; issues: PackageIssue[] };

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_SENTINEL = 0xffffffff;
const MAX_COMMENT_BYTES = 0xffff;
const UNIX_HOST = 3;
const SYMLINK_MODE_MASK = 0xa000;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    crc = (CRC_TABLE[(crc ^ (data[index] as number)) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function error(code: PackageIssue['code'], message: string, path?: string): PackageIssue {
  return { severity: 'error', code, message, ...(path ? { path } : {}) };
}

/**
 * Thrown while inflating an entry whose real output exceeds the per-entry cap.
 * Distinct from `archive-unreadable` so a size lie is reported with the
 * documented over-cap code instead of a generic corruption message.
 */
class EntryOutputTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`Decompressed output exceeds the ${limit}-byte per-entry safety limit.`);
    this.name = 'EntryOutputTooLargeError';
  }
}

/**
 * Inflates one raw-deflate entry with a hard output bound.
 *
 * fflate is given a preallocated `limit + 1` byte output buffer. With a caller
 * buffer (`st.i === 2`) fflate never resizes it, so the allocation cannot grow
 * with the decompressed stream; the extra byte is enough to distinguish "at the
 * cap" from "past the cap". Over-cap writes are clipped by the typed array and
 * the returned length reveals the overrun. Decompression CPU time is still
 * bounded by the compressed entry cap enforced before this call.
 */
function inflateBounded(input: Uint8Array, limit: number): Uint8Array {
  // fflate returns the caller buffer unchanged for an empty input; treat it as
  // an empty (and therefore mismatched) result instead of a cap overrun.
  if (input.length === 0) return new Uint8Array(0);
  let output: Uint8Array;
  try {
    output = inflateSync(input, { out: new Uint8Array(limit + 1) });
  } catch (cause) {
    // Stored deflate blocks use `TypedArray.set`, which throws instead of
    // clipping when the fixed buffer is too small; that also means the output
    // passed the cap.
    if (cause instanceof RangeError) throw new EntryOutputTooLargeError(limit);
    throw cause;
  }
  if (output.length > limit) throw new EntryOutputTooLargeError(limit);
  // `output` is a subarray of the limit-sized scratch buffer; copy it so an
  // accepted entry does not retain that buffer for the archive's lifetime.
  return output.slice();
}

function fail(issues: PackageIssue[]): ZipReadResult {
  return { ok: false, issues };
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] as number) | ((bytes[offset + 1] as number) << 8);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] as number) |
      ((bytes[offset + 1] as number) << 8) |
      ((bytes[offset + 2] as number) << 16) |
      ((bytes[offset + 3] as number) << 24)) >>>
    0
  );
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const minimum = Math.max(0, bytes.length - MAX_COMMENT_BYTES - 22);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (readUint32(bytes, offset) !== EOCD_SIGNATURE) continue;
    const commentLength = readUint16(bytes, offset + 20);
    if (offset + 22 + commentLength === bytes.length) return offset;
  }
  return -1;
}

interface CentralEntry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressedBytes: number;
  uncompressedBytes: number;
  localOffset: number;
  versionMadeBy: number;
  externalAttributes: number;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Decodes and validates one archive path; null means "unsafe path". */
export function normalizeArchivePath(rawName: string): string | null {
  if (rawName.length === 0 || rawName.startsWith('/') || rawName.startsWith('\\')) return null;
  if (rawName.includes('\\')) return null;
  if (/^[a-zA-Z]:/.test(rawName)) return null;
  for (let index = 0; index < rawName.length; index += 1) {
    const code = rawName.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return null;
  }
  const segments = rawName.split('/');
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..') return null;
  }
  return segments.join('/');
}

export function readZip(bytes: Uint8Array): ZipReadResult {
  if (bytes.length === 0) {
    return fail([error('archive-unreadable', 'The package file is empty. Choose a ZIP archive containing manifest.json.')]);
  }
  if (bytes.length > PACKAGE_SAFETY_LIMITS.maxArchiveBytes) {
    return fail([
      error(
        'archive-too-large',
        `The package archive is ${bytes.length} bytes; the import safety limit is ${PACKAGE_SAFETY_LIMITS.maxArchiveBytes} bytes. Remove large media from the package.`,
      ),
    ]);
  }

  const eocd = findEndOfCentralDirectory(bytes);
  if (eocd < 0) {
    return fail([
      error(
        'archive-unreadable',
        'The file is not a readable ZIP archive (end-of-central-directory record not found). Re-export it as a ZIP.',
      ),
    ]);
  }

  const diskNumber = readUint16(bytes, eocd + 4);
  const centralDisk = readUint16(bytes, eocd + 6);
  const entriesOnDisk = readUint16(bytes, eocd + 8);
  const totalEntries = readUint16(bytes, eocd + 10);
  const centralSize = readUint32(bytes, eocd + 12);
  const centralOffset = readUint32(bytes, eocd + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries) {
    return fail([
      error('archive-unreadable', 'Multi-disk ZIP archives are not supported. Save the package as a single-file ZIP.'),
    ]);
  }
  if (totalEntries === 0xffff || centralSize === ZIP64_SENTINEL || centralOffset === ZIP64_SENTINEL) {
    return fail([
      error(
        'archive-unreadable',
        'ZIP64 archives are not supported by this version. Re-export the package as a standard ZIP.',
      ),
    ]);
  }
  if (totalEntries > PACKAGE_SAFETY_LIMITS.maxEntries) {
    return fail([
      error(
        'entry-count-exceeded',
        `The package contains ${totalEntries} entries; the import safety limit is ${PACKAGE_SAFETY_LIMITS.maxEntries}. A package must contain only manifest.json and the declared assets.`,
      ),
    ]);
  }
  if (centralOffset + centralSize > bytes.length || centralOffset > eocd) {
    return fail([error('archive-unreadable', 'The ZIP central directory is outside the file. Re-export the package.')]);
  }

  const centralEntries: CentralEntry[] = [];
  let cursor = centralOffset;
  let totalUncompressed = 0;
  const seenNames = new Set<string>();

  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > bytes.length || readUint32(bytes, cursor) !== CENTRAL_SIGNATURE) {
      return fail([
        error('archive-unreadable', `The ZIP central directory entry ${index + 1} is malformed. Re-export the package.`),
      ]);
    }
    const versionMadeBy = readUint16(bytes, cursor + 4);
    const flags = readUint16(bytes, cursor + 8);
    const method = readUint16(bytes, cursor + 10);
    const crc = readUint32(bytes, cursor + 16);
    const compressedBytes = readUint32(bytes, cursor + 20);
    const uncompressedBytes = readUint32(bytes, cursor + 24);
    const nameLength = readUint16(bytes, cursor + 28);
    const extraLength = readUint16(bytes, cursor + 30);
    const commentLength = readUint16(bytes, cursor + 32);
    const externalAttributes = readUint32(bytes, cursor + 38);
    const localOffset = readUint32(bytes, cursor + 42);
    const nameStart = cursor + 46;
    const next = nameStart + nameLength + extraLength + commentLength;
    if (next > bytes.length || next > centralOffset + centralSize) {
      return fail([
        error('archive-unreadable', `The ZIP central directory entry ${index + 1} exceeds the archive. Re-export the package.`),
      ]);
    }
    let rawName: string;
    try {
      rawName = utf8.decode(bytes.subarray(nameStart, nameStart + nameLength));
    } catch {
      return fail([
        error('entry-path-unsafe', `Archive entry ${index + 1} has a name that is not valid UTF-8. Rename it to ASCII.`),
      ]);
    }
    cursor = next;

    if (compressedBytes === ZIP64_SENTINEL || uncompressedBytes === ZIP64_SENTINEL || localOffset === ZIP64_SENTINEL) {
      return fail([
        error(
          'archive-unreadable',
          `Archive entry "${rawName}" uses ZIP64 fields, which are not supported. Re-export as a standard ZIP.`,
        ),
      ]);
    }
    const isDirectory = rawName.endsWith('/');
    // Directory entries count toward the entry cap but are otherwise ignored.
    // Normalize and duplicate-check them before skipping: an unsafe
    // `../evil/` or `/absolute/` directory entry must be rejected exactly like
    // an unsafe file entry, not silently accepted.
    const name = normalizeArchivePath(isDirectory ? rawName.slice(0, -1) : rawName);
    if (!name) {
      return fail([
        error(
          'entry-path-unsafe',
          `Archive entry "${rawName}" has an unsafe path. Package paths must be relative, use forward slashes, and must not contain ".." or absolute roots.`,
          rawName,
        ),
      ]);
    }
    const key = `${isDirectory ? 'dir:' : 'file:'}${name.toLowerCase()}`;
    if (seenNames.has(key)) {
      return fail([
        error(
          'entry-duplicate',
          `Archive entry "${name}" appears more than once (case-insensitively). Each package file must have exactly one entry.`,
          name,
        ),
      ]);
    }
    seenNames.add(key);
    if (isDirectory) continue;

    if ((versionMadeBy >> 8) === UNIX_HOST && (((externalAttributes >>> 16) & 0xf000) === SYMLINK_MODE_MASK)) {
      return fail([
        error(
          'entry-symlink',
          `Archive entry "${name}" is a symbolic link. Packages may contain regular files only.`,
          name,
        ),
      ]);
    }
    if ((flags & 0x0001) !== 0) {
      return fail([error('entry-encrypted', `Archive entry "${name}" is encrypted. Packages must not be encrypted.`, name)]);
    }
    if (method !== 0 && method !== 8) {
      return fail([
        error(
          'entry-compression-unsupported',
          `Archive entry "${name}" uses compression method ${method}; only stored (0) and deflate (8) are supported.`,
          name,
        ),
      ]);
    }
    if (compressedBytes > PACKAGE_SAFETY_LIMITS.maxEntryCompressedBytes) {
      return fail([
        error(
          'entry-too-large',
          `Archive entry "${name}" is ${compressedBytes} compressed bytes; the per-entry safety limit is ${PACKAGE_SAFETY_LIMITS.maxEntryCompressedBytes}.`,
          name,
        ),
      ]);
    }
    if (uncompressedBytes > PACKAGE_SAFETY_LIMITS.maxEntryUncompressedBytes) {
      return fail([
        error(
          'entry-too-large',
          `Archive entry "${name}" declares ${uncompressedBytes} uncompressed bytes; the per-entry safety limit is ${PACKAGE_SAFETY_LIMITS.maxEntryUncompressedBytes}.`,
          name,
        ),
      ]);
    }
    totalUncompressed += uncompressedBytes;
    if (totalUncompressed > PACKAGE_SAFETY_LIMITS.maxTotalUncompressedBytes) {
      return fail([
        error(
          'archive-too-large',
          `The package declares more than ${PACKAGE_SAFETY_LIMITS.maxTotalUncompressedBytes} uncompressed bytes. Remove large media from the package.`,
        ),
      ]);
    }
    if (localOffset + 30 > bytes.length) {
      return fail([error('archive-unreadable', `Archive entry "${name}" has an invalid local header.`, name)]);
    }
    centralEntries.push({
      name,
      flags,
      method,
      crc,
      compressedBytes,
      uncompressedBytes,
      localOffset,
      versionMadeBy,
      externalAttributes,
    });
  }

  const entries: ZipEntry[] = [];
  for (const entry of centralEntries) {
    const local = entry.localOffset;
    if (readUint32(bytes, local) !== LOCAL_SIGNATURE) {
      return fail([error('archive-unreadable', `Archive entry "${entry.name}" has an invalid local header.`, entry.name)]);
    }
    const localNameLength = readUint16(bytes, local + 26);
    const localExtraLength = readUint16(bytes, local + 28);
    const localNameStart = local + 30;
    const localNameEnd = localNameStart + localNameLength;
    if (localNameEnd > bytes.length) {
      return fail([error('archive-unreadable', `Archive entry "${entry.name}" has a truncated local header.`, entry.name)]);
    }
    let localName: string;
    try {
      localName = utf8.decode(bytes.subarray(localNameStart, localNameEnd));
    } catch {
      return fail([error('entry-path-unsafe', `Archive entry "${entry.name}" has an invalid local name.`, entry.name)]);
    }
    if (localName !== entry.name) {
      return fail([
        error(
          'entry-path-unsafe',
          `Archive entry "${entry.name}" has a local header name that does not match its central directory name. Re-export the package.`,
          entry.name,
        ),
      ]);
    }
    const dataStart = localNameEnd + localExtraLength;
    const dataEnd = dataStart + entry.compressedBytes;
    if (dataEnd > bytes.length) {
      return fail([error('archive-unreadable', `Archive entry "${entry.name}" data is truncated.`, entry.name)]);
    }
    let data: Uint8Array;
    try {
      data =
        entry.method === 0
          ? new Uint8Array(bytes.subarray(dataStart, dataEnd))
          : inflateBounded(bytes.subarray(dataStart, dataEnd), PACKAGE_SAFETY_LIMITS.maxEntryUncompressedBytes);
    } catch (cause) {
      if (cause instanceof EntryOutputTooLargeError) {
        return fail([
          error(
            'entry-too-large',
            `Archive entry "${entry.name}" expands beyond the ${PACKAGE_SAFETY_LIMITS.maxEntryUncompressedBytes}-byte per-entry safety limit while decompressing. Remove large media from the package.`,
            entry.name,
          ),
        ]);
      }
      return fail([
        error(
          'archive-unreadable',
          `Archive entry "${entry.name}" could not be decompressed: ${(cause as Error).message}`,
          entry.name,
        ),
      ]);
    }
    if (data.length > PACKAGE_SAFETY_LIMITS.maxEntryUncompressedBytes) {
      return fail([
        error(
          'entry-too-large',
          `Archive entry "${entry.name}" expands to ${data.length} bytes; the per-entry safety limit is ${PACKAGE_SAFETY_LIMITS.maxEntryUncompressedBytes}.`,
          entry.name,
        ),
      ]);
    }
    if (data.length !== entry.uncompressedBytes) {
      return fail([
        error(
          'archive-unreadable',
          `Archive entry "${entry.name}" decompressed to ${data.length} bytes but declared ${entry.uncompressedBytes}.`,
          entry.name,
        ),
      ]);
    }
    if (crc32(data) !== entry.crc) {
      return fail([
        error('archive-unreadable', `Archive entry "${entry.name}" failed its CRC check; the archive is corrupt.`, entry.name),
      ]);
    }
    entries.push({
      name: entry.name,
      data,
      method: entry.method === 0 ? 0 : 8,
      compressedBytes: entry.compressedBytes,
      uncompressedBytes: entry.uncompressedBytes,
    });
  }

  return { ok: true, entries };
}
