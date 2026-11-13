#!/usr/bin/env node
/**
 * Reproducibly generates the committed effect-package fixtures:
 *
 *   fixtures/packages/guard-visor.zip    valid: rigid GLB mask + color treatment
 *   fixtures/packages/verdant-tint.zip   valid: declarative color treatment only
 *   fixtures/packages/negative/*.zip     one invalid package per validation code
 *
 * The mask GLB is written by a tiny deterministic glTF 2.0 binary writer below
 * (a small procedural box-built visor with one unlit material), so the repo
 * commits a readable generator and kilobytes of fixtures instead of opaque
 * binaries. The ZIPs are deterministic (fixed DOS timestamp, fixed deflate
 * level), so re-running this script produces byte-identical fixtures.
 *
 * Run with `npm run build:packages`. The public-workflow check imports these
 * packages through the real app control and validates the negative ones.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(root, 'fixtures', 'packages');
const negativeDir = path.join(outputDir, 'negative');
const FIXED_MTIME = new Date(Date.UTC(1980, 0, 2, 12, 0, 0));
const DOS_DATE_1980 = 0x0021;
const DOS_TIME_MIDNIGHT = 0;

// ---------------------------------------------------------------------------
// Deterministic ZIP writer (stored entries) for cases fflate's object API
// cannot represent: duplicate names and symbolic-link external attributes.
// ---------------------------------------------------------------------------

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

function crc32(data) {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    crc = CRC_TABLE[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * @param {{name: string, data: Uint8Array, unixSymlink?: boolean}[]} files
 */
function writeStoredZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.from(file.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(DOS_TIME_MIDNIGHT, 10);
    local.writeUInt16LE(DOS_DATE_1980, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(file.unixSymlink ? 0x0314 : 20, 4); // version made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME_MIDNIGHT, 12);
    central.writeUInt16LE(DOS_DATE_1980, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(file.unixSymlink ? 0xa1ff0000 : 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBytes, end]);
}

/** Standard deflate ZIP (fflate) with a fixed timestamp for reproducibility. */
function writeDeflatedZip(files) {
  const source = {};
  for (const [name, data] of Object.entries(files)) source[name] = data;
  return Buffer.from(zipSync(source, { level: 9, mtime: FIXED_MTIME }));
}

// ---------------------------------------------------------------------------
// Deterministic GLB writer: a rigid visor built from axis-aligned boxes with a
// single unlit material. Boxes are deliberately symmetric so the projected
// bounding-box centre lands on solid geometry; the public check probes that
// pixel as exact-colour evidence that the package mask is composited.
// ---------------------------------------------------------------------------

const SRGB_TO_LINEAR = (value) => {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
};

function boxGeometry(boxes) {
  const positions = [];
  const indices = [];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const [cx, cy, cz, sx, sy, sz] of boxes) {
    const x0 = cx - sx / 2;
    const x1 = cx + sx / 2;
    const y0 = cy - sy / 2;
    const y1 = cy + sy / 2;
    const z0 = cz - sz / 2;
    const z1 = cz + sz / 2;
    const base = positions.length / 3;
    const corners = [
      [x0, y0, z0],
      [x1, y0, z0],
      [x1, y1, z0],
      [x0, y1, z0],
      [x0, y0, z1],
      [x1, y0, z1],
      [x1, y1, z1],
      [x0, y1, z1],
    ];
    for (const [x, y, z] of corners) {
      positions.push(x, y, z);
      min[0] = Math.min(min[0], x);
      min[1] = Math.min(min[1], y);
      min[2] = Math.min(min[2], z);
      max[0] = Math.max(max[0], x);
      max[1] = Math.max(max[1], y);
      max[2] = Math.max(max[2], z);
    }
    const faces = [
      [4, 5, 6, 4, 6, 7],
      [1, 0, 3, 1, 3, 2],
      [0, 4, 7, 0, 7, 3],
      [5, 1, 2, 5, 2, 6],
      [3, 7, 6, 3, 6, 2],
      [0, 1, 5, 0, 5, 4],
    ];
    for (const face of faces) for (const vertex of face) indices.push(base + vertex);
  }
  return { positions, indices, min, max };
}

/**
 * @param {{boxes: number[][], colorSrgb: [number, number, number], document?: object, embedBin?: boolean}} options
 */
function buildGlb({ boxes, colorSrgb, document = {}, embedBin = true }) {
  const geometry = boxGeometry(boxes);
  const positionBytes = geometry.positions.length * 4;
  const indexBytes = geometry.indices.length * 2;
  const binLength = positionBytes + indexBytes;
  const bin = Buffer.alloc(binLength);
  geometry.positions.forEach((value, index) => bin.writeFloatLE(value, index * 4));
  geometry.indices.forEach((value, index) => bin.writeUInt16LE(value, positionBytes + index * 2));

  const gltf = {
    asset: { version: '2.0', generator: 'shymask scripts/build-package-fixtures.mjs' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'GuardVisor' }],
    meshes: [
      {
        name: 'GuardVisor',
        primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0, mode: 4 }],
      },
    ],
    materials: [
      {
        name: 'GuardVisorUnlit',
        doubleSided: false,
        pbrMetallicRoughness: {
          baseColorFactor: [
            SRGB_TO_LINEAR(colorSrgb[0]),
            SRGB_TO_LINEAR(colorSrgb[1]),
            SRGB_TO_LINEAR(colorSrgb[2]),
            1,
          ],
          metallicFactor: 0,
          roughnessFactor: 1,
        },
        extensions: { KHR_materials_unlit: {} },
      },
    ],
    extensionsUsed: ['KHR_materials_unlit'],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: geometry.positions.length / 3,
        type: 'VEC3',
        min: geometry.min,
        max: geometry.max,
      },
      {
        bufferView: 1,
        componentType: 5123,
        count: geometry.indices.length,
        type: 'SCALAR',
      },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positionBytes, target: 34962 },
      { buffer: 0, byteOffset: positionBytes, byteLength: indexBytes, target: 34963 },
    ],
    buffers: embedBin ? [{ byteLength: binLength }] : [{ uri: 'mask.bin', byteLength: binLength }],
  };

  mergeDocument(gltf, document);

  const jsonBytes = Buffer.from(JSON.stringify(gltf), 'utf8');
  const jsonPadding = (4 - (jsonBytes.length % 4)) % 4;
  const paddedJson = Buffer.concat([jsonBytes, Buffer.alloc(jsonPadding, 0x20)]);
  const binPadding = (4 - (bin.length % 4)) % 4;
  const paddedBin = Buffer.concat([bin, Buffer.alloc(binPadding, 0)]);
  const chunks = [makeChunk(0x4e4f534a, paddedJson)];
  if (embedBin) chunks.push(makeChunk(0x004e4942, paddedBin));
  const totalLength = 12 + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // 'glTF'
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLength, 8);
  return Buffer.concat([header, ...chunks]);
}

function makeChunk(type, data) {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(data.length, 0);
  header.writeUInt32LE(type, 4);
  return Buffer.concat([header, data]);
}

function mergeDocument(target, overrides) {
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    if (key === 'buffers') {
      target.buffers = value;
    } else if (key === 'extensionsRequired') {
      target.extensionsRequired = value;
    } else {
      target[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GUARD_VISOR_BOXES = [
  [0, 0, 4.5, 18, 12, 2], // main face plate (dominates the bounding box centre)
  [0, 5.5, 4.2, 19, 2.5, 2.4], // brow bar
  [0, 9.5, 3.6, 2.2, 7, 2], // crest
  [0, -6.5, 4.6, 8, 1.6, 1.6], // chin guard
  [-10.2, 0, 3.8, 1.6, 6, 3], // left fin
  [10.2, 0, 3.8, 1.6, 6, 3], // right fin
  [-7.8, -3.8, 5.2, 1.6, 3.4, 1.6], // left cheek plate
  [7.8, -3.8, 5.2, 1.6, 3.4, 1.6], // right cheek plate
];
/** Distinct, exact sRGB colour; not used by any bundled mask material. */
const GUARD_VISOR_COLOR = [225, 29, 154];

const guardVisorManifest = {
  schemaVersion: 1,
  id: 'shymask.guard-visor',
  name: 'Guard visor',
  version: '1.0.0',
  description: 'Rigid unlit visor attached to the tracked face, combined with a cool color treatment.',
  author: {
    name: 'Shymask sample author',
    attribution: 'Generated reproducibly by scripts/build-package-fixtures.mjs',
    license: 'CC0-1.0',
  },
  mask: {
    asset: 'assets/guard-visor.glb',
    attachment: { position: [0, 0, 0], rotationDeg: [0, 0, 0], scale: 1 },
  },
  colorTreatment: { saturation: 1.15, hueRotateDeg: -8, contrast: 1.05 },
};

const verdantManifest = {
  schemaVersion: 1,
  id: 'shymask.verdant-tint',
  name: 'Verdant tint',
  version: '1.0.0',
  description: 'A declarative green-shifted color treatment with no mask.',
  author: {
    name: 'Shymask sample author',
    attribution: 'Generated reproducibly by scripts/build-package-fixtures.mjs',
    license: 'CC0-1.0',
  },
  colorTreatment: { sepia: 0.6, hueRotateDeg: 90, saturation: 1.8, brightness: 1.02 },
};

function manifestBytes(manifest) {
  return strToU8(`${JSON.stringify(manifest, null, 2)}\n`);
}

function writePackage(fileName, files) {
  const target = path.join(outputDir, fileName);
  const archive = writeDeflatedZip(files);
  writeFileSync(target, archive);
  console.log(`wrote ${path.relative(root, target)} (${archive.length} bytes)`);
}

function writeNegative(name, files) {
  const target = path.join(negativeDir, `${name}.zip`);
  writeFileSync(target, writeDeflatedZip(files));
  console.log(`wrote ${path.relative(root, target)}`);
}

function validMaskGlb() {
  return buildGlb({ boxes: GUARD_VISOR_BOXES, colorSrgb: GUARD_VISOR_COLOR });
}

function mutateManifest(base, mutate) {
  const manifest = JSON.parse(JSON.stringify(base));
  mutate(manifest);
  return manifestBytes(manifest);
}

function main() {
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(negativeDir, { recursive: true });

  const glb = validMaskGlb();

  writePackage('guard-visor.zip', {
    'manifest.json': manifestBytes(guardVisorManifest),
    'assets/guard-visor.glb': glb,
  });
  writePackage('verdant-tint.zip', {
    'manifest.json': manifestBytes(verdantManifest),
  });

  // Required negative fixtures: malformed JSON, unsupported schemaVersion,
  // unsupported behavior, missing asset, invalid color parameters, zip-slip,
  // oversized entry, executable content.
  writeNegative('malformed-json', {
    'manifest.json': strToU8('{ "schemaVersion": 1, this is not valid JSON'),
    'assets/guard-visor.glb': glb,
  });
  writeNegative('schema-version-2', {
    'manifest.json': mutateManifest(guardVisorManifest, (manifest) => {
      manifest.schemaVersion = 2;
    }),
    'assets/guard-visor.glb': glb,
  });
  writeNegative('unsupported-behavior', {
    'manifest.json': mutateManifest(guardVisorManifest, (manifest) => {
      manifest.expressionReactions = [{ type: 'blink', asset: 'assets/eyes.glb' }];
    }),
    'assets/guard-visor.glb': glb,
  });
  writeNegative('missing-asset', {
    'manifest.json': mutateManifest(guardVisorManifest, (manifest) => {
      manifest.mask.asset = 'assets/missing.glb';
    }),
  });
  writeNegative('invalid-color', {
    'manifest.json': mutateManifest(guardVisorManifest, (manifest) => {
      manifest.colorTreatment.saturation = 9;
    }),
    'assets/guard-visor.glb': glb,
  });
  writeNegative('zip-slip', {
    'manifest.json': manifestBytes(guardVisorManifest),
    'assets/guard-visor.glb': glb,
    '../escape.glb': strToU8('not really a glb'),
  });
  writeNegative('oversized-entry', {
    'manifest.json': manifestBytes(guardVisorManifest),
    'assets/guard-visor.glb': glb,
    'assets/huge.glb': new Uint8Array(4 * 1024 * 1024 + 1),
  });
  writeNegative('executable-file', {
    'manifest.json': manifestBytes(guardVisorManifest),
    'assets/guard-visor.glb': glb,
    'assets/payload.js': strToU8('process.exit(0);'),
  });
  writeNegative('manifest-missing', {
    'assets/guard-visor.glb': glb,
  });
  writeNegative('empty-effect', {
    'manifest.json': manifestBytes({
      schemaVersion: 1,
      id: 'shymask.empty',
      name: 'Empty',
      version: '1.0.0',
      description: 'Declares neither a mask nor a color treatment.',
      author: { name: 'Shymask sample author' },
    }),
  });
  writeNegative('unsupported-gltf-extension', {
    'manifest.json': manifestBytes(guardVisorManifest),
    'assets/guard-visor.glb': buildGlb({
      boxes: GUARD_VISOR_BOXES,
      colorSrgb: GUARD_VISOR_COLOR,
      document: { extensionsRequired: ['KHR_draco_mesh_compression'] },
    }),
  });
  writeNegative('gltf-animation', {
    'manifest.json': manifestBytes(guardVisorManifest),
    'assets/guard-visor.glb': buildGlb({
      boxes: GUARD_VISOR_BOXES,
      colorSrgb: GUARD_VISOR_COLOR,
      document: { animations: [{ channels: [], samplers: [] }] },
    }),
  });
  writeNegative('external-resource', {
    'manifest.json': manifestBytes(guardVisorManifest),
    'assets/guard-visor.glb': buildGlb({
      boxes: GUARD_VISOR_BOXES,
      colorSrgb: GUARD_VISOR_COLOR,
      embedBin: false,
    }),
  });
  writeNegative('unsupported-asset-type', {
    'manifest.json': mutateManifest(guardVisorManifest, (manifest) => {
      manifest.mask.asset = 'assets/guard-visor.gltf';
    }),
    'assets/guard-visor.gltf': strToU8('{"asset":{"version":"2.0"}}'),
  });

  // Cases fflate's object API cannot express: a symbolic link and duplicate
  // names. Both are written with the deterministic stored-entry writer.
  writeFileSync(
    path.join(negativeDir, 'symlink.zip'),
    writeStoredZip([
      { name: 'manifest.json', data: manifestBytes(guardVisorManifest) },
      { name: 'assets/guard-visor.glb', data: glb },
      { name: 'assets/link.glb', data: strToU8('../escape.glb'), unixSymlink: true },
    ]),
  );
  console.log(`wrote ${path.relative(root, path.join(negativeDir, 'symlink.zip'))}`);
  writeFileSync(
    path.join(negativeDir, 'duplicate-entry.zip'),
    writeStoredZip([
      { name: 'manifest.json', data: manifestBytes(guardVisorManifest) },
      { name: 'assets/guard-visor.glb', data: glb },
      { name: 'assets/guard-visor.glb', data: glb },
    ]),
  );
  console.log(`wrote ${path.relative(root, path.join(negativeDir, 'duplicate-entry.zip'))}`);
}

main();
