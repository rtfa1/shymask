/**
 * Structural validation for a package mask asset (glTF 2.0 binary / `.glb`).
 *
 * This is intentionally not a renderer. It proves the bytes are a well-formed,
 * self-contained GLB with triangle meshes and no behavior this build cannot
 * execute (animations, skins, cameras, lights, external buffers/images, or a
 * required glTF extension Three.js would not load here). Three.js GLTFLoader
 * performs the actual parse in the renderer; rejecting unsupported features
 * here keeps the contract honest instead of silently ignoring them.
 */

import type { PackageIssue } from './effect-package-contract';

export interface GlbSummary {
  triangles: number;
  meshes: number;
  materials: number;
  nodes: number;
  textures: number;
}

export type GlbInspection = { ok: true; summary: GlbSummary } | { ok: false; issues: PackageIssue[] };

const GLB_MAGIC = 0x46546c67; // 'glTF' little-endian
const GLB_VERSION = 2;
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'
const SUPPORTED_REQUIRED_EXTENSIONS = new Set(['KHR_materials_unlit']);
/** Valid glTF 2.0 accessor componentType values and their byte widths. */
const ACCESSOR_COMPONENT_BYTES = new Map<number, number>([
  [5120, 1], // BYTE
  [5121, 1], // UNSIGNED_BYTE
  [5122, 2], // SHORT
  [5123, 2], // UNSIGNED_SHORT
  [5125, 4], // UNSIGNED_INT
  [5126, 4], // FLOAT
]);
/** Valid glTF 2.0 accessor type strings and their component counts. */
const ACCESSOR_TYPE_COMPONENTS = new Map<string, number>([
  ['SCALAR', 1],
  ['VEC2', 2],
  ['VEC3', 3],
  ['VEC4', 4],
  ['MAT2', 4],
  ['MAT3', 9],
  ['MAT4', 16],
]);
/** Index accessors may only use the integer component types glTF allows. */
const INDEX_COMPONENT_TYPES = new Set([5121, 5123, 5125]);
const FLOAT_COMPONENT_TYPE = 5126;
const utf8 = new TextDecoder('utf-8', { fatal: true });

function error(code: PackageIssue['code'], message: string, path?: string): PackageIssue {
  return { severity: 'error', code, message, ...(path ? { path } : {}) };
}

interface GltfAccessor {
  count?: unknown;
  bufferView?: unknown;
  byteOffset?: unknown;
  componentType?: unknown;
  type?: unknown;
}

interface GltfPrimitive {
  attributes?: Record<string, unknown>;
  indices?: unknown;
  mode?: unknown;
}

interface GltfMesh {
  primitives?: unknown;
}

interface GltfDocument {
  asset?: { version?: unknown };
  buffers?: unknown;
  bufferViews?: unknown;
  accessors?: unknown;
  images?: unknown;
  meshes?: unknown;
  materials?: unknown;
  nodes?: unknown;
  textures?: unknown;
  animations?: unknown;
  skins?: unknown;
  cameras?: unknown;
  extensions?: unknown;
  extensionsRequired?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Rejects external (non-embedded) resources: packages are self-contained. */
function checkExternalUris(list: unknown, kind: string, issues: PackageIssue[]): void {
  for (const [index, item] of asArray(list).entries()) {
    if (!isRecord(item) || item.uri === undefined) continue;
    const uri = item.uri;
    if (typeof uri !== 'string' || !uri.startsWith('data:')) {
      issues.push(
        error(
          'glb-external-resource',
          `The mask's ${kind}[${index}] refers to an external resource (${String(uri)}). Export a self-contained GLB with embedded buffers and images.`,
        ),
      );
    }
  }
}

export function inspectGlb(bytes: Uint8Array): GlbInspection {
  if (bytes.length < 12) {
    return { ok: false, issues: [error('glb-invalid', 'The mask asset is too small to be a GLB file.')] };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) {
    return {
      ok: false,
      issues: [error('glb-invalid', 'The mask asset is not a binary glTF (GLB) file; the magic header is missing.')],
    };
  }
  if (view.getUint32(4, true) !== GLB_VERSION) {
    return {
      ok: false,
      issues: [error('glb-invalid', `The mask asset is glTF version ${view.getUint32(4, true)}; only GLB version 2 is supported.`)],
    };
  }
  const declaredLength = view.getUint32(8, true);
  if (declaredLength !== bytes.length) {
    return {
      ok: false,
      issues: [
        error(
          'glb-invalid',
          `The GLB header declares ${declaredLength} bytes but the asset is ${bytes.length} bytes. Re-export the asset.`,
        ),
      ],
    };
  }

  const chunks: Array<{ type: number; data: Uint8Array }> = [];
  let offset = 12;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) {
      return { ok: false, issues: [error('glb-invalid', 'The GLB chunk header is truncated.')] };
    }
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + length;
    if (end > bytes.length) {
      return { ok: false, issues: [error('glb-invalid', 'A GLB chunk extends past the end of the asset.')] };
    }
    chunks.push({ type, data: bytes.subarray(start, end) });
    offset = end + ((4 - (length % 4)) % 4);
  }
  const jsonChunk = chunks[0];
  if (!jsonChunk || jsonChunk.type !== CHUNK_JSON) {
    return { ok: false, issues: [error('glb-invalid', 'The GLB does not start with a JSON chunk.')] };
  }
  const binChunk = chunks.find((chunk) => chunk.type === CHUNK_BIN);
  let rawJson: string;
  try {
    rawJson = utf8.decode(jsonChunk.data).replace(/[\u0000\u0020]+$/u, '');
  } catch {
    return { ok: false, issues: [error('glb-invalid', 'The GLB JSON chunk is not valid UTF-8.')] };
  }
  let document: GltfDocument;
  try {
    document = JSON.parse(rawJson) as GltfDocument;
  } catch (cause) {
    return {
      ok: false,
      issues: [error('glb-invalid', `The GLB JSON chunk is not valid JSON: ${(cause as Error).message}`)],
    };
  }
  if (!isRecord(document)) {
    return { ok: false, issues: [error('glb-invalid', 'The GLB JSON chunk must contain a glTF object.')] };
  }
  const assetVersion = isRecord(document.asset) ? document.asset.version : undefined;
  if (assetVersion !== '2.0') {
    return {
      ok: false,
      issues: [error('glb-invalid', `The mask asset must declare asset.version "2.0"; got ${JSON.stringify(assetVersion)}.`)],
    };
  }

  const issues: PackageIssue[] = [];
  const requiredExtensions = asArray(document.extensionsRequired);
  for (const extension of requiredExtensions) {
    if (typeof extension !== 'string' || !SUPPORTED_REQUIRED_EXTENSIONS.has(extension)) {
      issues.push(
        error(
          'glb-unsupported-extension',
          `The mask requires the glTF extension "${String(extension)}", which this version does not support. Export without it.`,
        ),
      );
    }
  }
  if (isRecord(document.extensions) && document.extensions.KHR_lights_punctual !== undefined) {
    issues.push(
      error(
        'glb-unsupported-feature',
        'The mask asset declares lights (KHR_lights_punctual). Shymask supplies its own lighting; remove lights from the export.',
      ),
    );
  }
  if (asArray(document.animations).length > 0) {
    issues.push(
      error(
        'unsupported-behavior',
        'The mask asset contains glTF animations. v1 attachments are rigid and animations are not played; export a static pose.',
      ),
    );
  }
  if (asArray(document.skins).length > 0) {
    issues.push(
      error(
        'unsupported-behavior',
        'The mask asset contains skins/joints. v1 supports rigid masks only; export the mask as static meshes.',
      ),
    );
  }
  if (asArray(document.cameras).length > 0) {
    issues.push(
      error(
        'glb-unsupported-feature',
        'The mask asset declares cameras, which are ignored by Shymask. Export meshes only.',
      ),
    );
  }

  checkExternalUris(document.buffers, 'buffers', issues);
  checkExternalUris(document.images, 'images', issues);

  if (issues.length > 0) return { ok: false, issues };

  const buffers = asArray(document.buffers);
  const bufferViews = asArray(document.bufferViews);
  const accessors = asArray(document.accessors);
  for (const [index, buffer] of buffers.entries()) {
    if (!isRecord(buffer) || !isNonNegativeInteger(buffer.byteLength)) {
      return { ok: false, issues: [error('glb-invalid', `buffers[${index}] must declare a non-negative byteLength.`)] };
    }
    if (buffer.uri === undefined) {
      if (index !== 0) {
        return {
          ok: false,
          issues: [error('glb-invalid', 'Only the first GLB buffer may use the embedded binary chunk.')],
        };
      }
      if (!binChunk) {
        return { ok: false, issues: [error('glb-invalid', 'The GLB declares an embedded buffer but has no BIN chunk.')] };
      }
      if (buffer.byteLength > binChunk.data.length) {
        return {
          ok: false,
          issues: [
            error(
              'glb-invalid',
              `buffers[0] declares ${buffer.byteLength} bytes but the BIN chunk is ${binChunk.data.length} bytes.`,
            ),
          ],
        };
      }
    }
  }
  for (const [index, bufferView] of bufferViews.entries()) {
    if (!isRecord(bufferView) || !isNonNegativeInteger(bufferView.buffer) || bufferView.buffer >= buffers.length) {
      return { ok: false, issues: [error('glb-invalid', `bufferViews[${index}] refers to a missing buffer.`)] };
    }
    if (!isNonNegativeInteger(bufferView.byteLength)) {
      return { ok: false, issues: [error('glb-invalid', `bufferViews[${index}] must declare a byteLength.`)] };
    }
    const buffer = buffers[bufferView.buffer];
    if (isRecord(buffer) && isNonNegativeInteger(buffer.byteLength)) {
      const byteOffset = isNonNegativeInteger(bufferView.byteOffset) ? bufferView.byteOffset : 0;
      if (byteOffset + bufferView.byteLength > buffer.byteLength) {
        return {
          ok: false,
          issues: [error('glb-invalid', `bufferViews[${index}] extends past its buffer.`)],
        };
      }
    }
  }
  for (const [index, accessor] of accessors.entries()) {
    if (!isRecord(accessor) || !isNonNegativeInteger(accessor.count)) {
      return { ok: false, issues: [error('glb-invalid', `accessors[${index}] must declare a non-negative count.`)] };
    }
    // glTF requires both fields on every accessor. Validating them here means a
    // damaged export is rejected at import instead of failing later in
    // GLTFLoader (which would surface as an effect-load error at selection).
    if (
      typeof accessor.componentType !== 'number' ||
      !ACCESSOR_COMPONENT_BYTES.has(accessor.componentType)
    ) {
      return {
        ok: false,
        issues: [
          error(
            'glb-invalid',
            `accessors[${index}] must declare a supported componentType (5120, 5121, 5122, 5123, 5125 or 5126).`,
          ),
        ],
      };
    }
    if (typeof accessor.type !== 'string' || !ACCESSOR_TYPE_COMPONENTS.has(accessor.type)) {
      return {
        ok: false,
        issues: [
          error(
            'glb-invalid',
            `accessors[${index}] must declare a supported type (SCALAR, VEC2, VEC3, VEC4, MAT2, MAT3 or MAT4).`,
          ),
        ],
      };
    }
    if (accessor.bufferView !== undefined) {
      if (!isNonNegativeInteger(accessor.bufferView) || accessor.bufferView >= bufferViews.length) {
        return { ok: false, issues: [error('glb-invalid', `accessors[${index}] refers to a missing bufferView.`)] };
      }
      const byteOffset = accessor.byteOffset === undefined ? 0 : accessor.byteOffset;
      if (!isNonNegativeInteger(byteOffset)) {
        return { ok: false, issues: [error('glb-invalid', `accessors[${index}] has an invalid byteOffset.`)] };
      }
      const view = bufferViews[accessor.bufferView];
      if (isRecord(view) && isNonNegativeInteger(view.byteLength)) {
        const elementBytes =
          (ACCESSOR_COMPONENT_BYTES.get(accessor.componentType) as number) *
          (ACCESSOR_TYPE_COMPONENTS.get(accessor.type) as number);
        if (byteOffset + elementBytes * accessor.count > view.byteLength) {
          return {
            ok: false,
            issues: [error('glb-invalid', `accessors[${index}] extends past its bufferView.`)],
          };
        }
      }
    }
  }

  const meshes = asArray(document.meshes) as GltfMesh[];
  if (meshes.length === 0) {
    return { ok: false, issues: [error('glb-invalid', 'The mask asset contains no meshes.')] };
  }
  let triangles = 0;
  for (const [meshIndex, mesh] of meshes.entries()) {
    if (!isRecord(mesh) || !Array.isArray(mesh.primitives) || mesh.primitives.length === 0) {
      return { ok: false, issues: [error('glb-invalid', `meshes[${meshIndex}] must contain at least one primitive.`)] };
    }
    for (const [primitiveIndex, primitive] of (mesh.primitives as GltfPrimitive[]).entries()) {
      if (!isRecord(primitive)) {
        return { ok: false, issues: [error('glb-invalid', `meshes[${meshIndex}].primitives[${primitiveIndex}] is malformed.`)] };
      }
      const mode = primitive.mode === undefined ? 4 : primitive.mode;
      if (mode !== 4) {
        return {
          ok: false,
          issues: [
            error(
              'glb-unsupported-feature',
              `meshes[${meshIndex}].primitives[${primitiveIndex}] uses mode ${String(mode)}; only triangle lists (mode 4) are supported.`,
            ),
          ],
        };
      }
      const position = isRecord(primitive.attributes) ? primitive.attributes.POSITION : undefined;
      if (!isNonNegativeInteger(position) || position >= accessors.length) {
        return {
          ok: false,
          issues: [
            error('glb-invalid', `meshes[${meshIndex}].primitives[${primitiveIndex}] has no valid POSITION attribute.`),
          ],
        };
      }
      const positionAccessor = accessors[position] as GltfAccessor;
      if (positionAccessor.type !== 'VEC3' || positionAccessor.componentType !== FLOAT_COMPONENT_TYPE) {
        return {
          ok: false,
          issues: [
            error(
              'glb-invalid',
              `meshes[${meshIndex}].primitives[${primitiveIndex}] POSITION must be a FLOAT VEC3 accessor.`,
            ),
          ],
        };
      }
      let vertexOrIndexCount: number;
      if (primitive.indices !== undefined) {
        if (!isNonNegativeInteger(primitive.indices) || primitive.indices >= accessors.length) {
          return {
            ok: false,
            issues: [error('glb-invalid', `meshes[${meshIndex}].primitives[${primitiveIndex}] has invalid indices.`)],
          };
        }
        const accessor = accessors[primitive.indices] as GltfAccessor;
        if (
          accessor.type !== 'SCALAR' ||
          typeof accessor.componentType !== 'number' ||
          !INDEX_COMPONENT_TYPES.has(accessor.componentType)
        ) {
          return {
            ok: false,
            issues: [
              error(
                'glb-invalid',
                `meshes[${meshIndex}].primitives[${primitiveIndex}] indices must be an unsigned-integer SCALAR accessor.`,
              ),
            ],
          };
        }
        vertexOrIndexCount = accessor.count as number;
      } else {
        vertexOrIndexCount = positionAccessor.count as number;
      }
      triangles += Math.floor(vertexOrIndexCount / 3);
    }
  }
  if (triangles === 0) {
    return { ok: false, issues: [error('glb-invalid', 'The mask asset contains no triangle geometry.')] };
  }

  return {
    ok: true,
    summary: {
      triangles,
      meshes: meshes.length,
      materials: asArray(document.materials).length,
      nodes: asArray(document.nodes).length,
      textures: asArray(document.textures).length,
    },
  };
}
