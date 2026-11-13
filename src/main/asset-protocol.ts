import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Local asset protocol for the Electron app.
 *
 * The renderer is served from `shymask://app/...` instead of `file://` so that
 * the MediaPipe WASM fileset and model can be fetched with the normal Fetch API
 * under a strict CSP, and so the replay clip can be streamed with byte-range
 * support. Only files under the configured roots are reachable, and directory
 * traversal is rejected. There are no Windows APIs and no network listener.
 */

export interface AssetRoots {
  rendererDir: string;
  trackerDir: string;
  fixtureDir: string;
}

interface ResolvedAsset {
  file: string;
  mime: string;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.webm': 'video/webm',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

const ROUTES = {
  fixture: 'fixtureDir',
  tracker: 'trackerDir',
} as const;

function safeJoin(root: string, segments: string[]): string | null {
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..' || /[\\/]/.test(segment)) return null;
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...segments);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) return null;
  return resolved;
}

/** Maps `shymask://app/<pathname>` to a file inside one of the allowed roots. */
export function resolveAssetPath(roots: AssetRoots, pathname: string): ResolvedAsset | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const segments = decoded.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;

  const [route, ...rest] = segments;
  let root: string;
  let relative: string[];
  if (route === 'fixture' || route === 'tracker') {
    root = roots[ROUTES[route]];
    relative = rest;
  } else {
    // The renderer bundle lives at the protocol root.
    root = roots.rendererDir;
    relative = segments;
  }
  if (relative.length === 0) return null;

  const file = safeJoin(root, relative);
  if (!file || !existsSync(file) || !statSync(file).isFile()) return null;
  const extension = path.extname(file).toLowerCase();
  return { file, mime: MIME_TYPES[extension] ?? 'application/octet-stream' };
}

function rangeResponse(bytes: Buffer, mime: string, request: Request): Response {
  const total = bytes.length;
  const range = request.headers.get('range');
  const headers: Record<string, string> = {
    'content-type': mime,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  };
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match) {
      let start = match[1] ? Number(match[1]) : 0;
      let end = match[2] ? Number(match[2]) : total - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        return new Response(null, { status: 416, headers: { 'content-range': `bytes */${total}` } });
      }
      if (start < 0 || end >= total || start > end) {
        // A suffix range such as `bytes=-N` is not needed by Chromium media.
        return new Response(null, { status: 416, headers: { 'content-range': `bytes */${total}` } });
      }
      end = Math.min(end, total - 1);
      const slice = new Uint8Array(bytes.subarray(start, end + 1));
      return new Response(slice, {
        status: 206,
        headers: {
          ...headers,
          'content-length': String(slice.length),
          'content-range': `bytes ${start}-${end}/${total}`,
        },
      });
    }
  }
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { ...headers, 'content-length': String(total) },
  });
}

export function createAssetResponse(asset: ResolvedAsset, request: Request): Response {
  const bytes = readFileSync(asset.file);
  if (request.method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: {
        'content-type': asset.mime,
        'content-length': String(bytes.length),
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
      },
    });
  }
  return rangeResponse(bytes, asset.mime, request);
}

/** Handler passed to `protocol.handle('shymask', ...)`. */
export function createAssetHandler(roots: AssetRoots): (request: Request) => Response {
  return (request: Request): Response => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    if (url.host !== 'app') return new Response('Not found', { status: 404 });
    const asset = resolveAssetPath(roots, url.pathname);
    if (!asset) return new Response('Not found', { status: 404 });
    try {
      return createAssetResponse(asset, request);
    } catch (error) {
      return new Response(`Asset read failed: ${(error as Error).message}`, { status: 500 });
    }
  };
}
