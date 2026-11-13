import { realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * Shared path containment helper for the local asset protocol and the
 * effect-package store.
 *
 * `safeJoin` rejects traversal/absolute/backslash segments and proves the
 * resolved path stays under `root`; callers that read or write a real file must
 * also use one of the realpath-checking variants so a symlink inside a root
 * cannot escape it.
 */

/** Resolves `segments` under `root`, or null for an unsafe/escaping path. */
export function safeJoin(root: string, segments: readonly string[]): string | null {
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..' || /[\\/]/.test(segment)) return null;
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...segments);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) return null;
  return resolved;
}

/**
 * Resolves an existing file under `root`, comparing real paths so a symlink
 * inside the root that points outside it is rejected. Returns null when the
 * path is unsafe or does not exist.
 */
export function resolveRealFile(root: string, segments: readonly string[]): string | null {
  const file = safeJoin(root, segments);
  if (!file) return null;
  try {
    const realRoot = realpathSync(root);
    const realFile = realpathSync(file);
    if (realFile !== realRoot && !realFile.startsWith(realRoot + path.sep)) return null;
    return realFile;
  } catch {
    return null;
  }
}

/**
 * Resolves a file that is about to be written under `root`. The leaf may not
 * exist yet, so its parent directory is realpath-checked instead; this keeps an
 * extraction target from escaping through a symlinked directory.
 */
export function safeJoinForWrite(root: string, segments: readonly string[]): string | null {
  const file = safeJoin(root, segments);
  if (!file) return null;
  try {
    const realRoot = realpathSync(root);
    const realParent = realpathSync(path.dirname(file));
    if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) return null;
    return file;
  } catch {
    return null;
  }
}
