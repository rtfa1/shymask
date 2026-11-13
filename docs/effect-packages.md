# Effect packages (schema v1)

Shymask effects can be imported as **validated effect packages**. A package
contains supported assets and declared behaviors only — never executable effect
code. This document is the creator-facing contract for schema version **1**, the
validation and import behavior, what is explicitly unsupported, and guidance for
the later AI-authoring slice ([issue #9]).

This slice was validated with recorded replay input and the Windows virtual
camera (see [validation evidence](#validation-and-evidence)); no physical webcam
or human participation is used. Playback never needs Blender or an AI process:
those tools produce a package before import.

## What a package is

A package is a ZIP archive with exactly two kinds of entries:

```
manifest.json                  required, at the archive root
assets/<file>.glb              only the mask asset the manifest declares
```

- The manifest is versioned with `schemaVersion: 1`. Other versions are
  rejected with `schema-version-unsupported`.
- Only one complete effect is selected at a time. A complete effect may combine
  a rigid mask **and** a color treatment; there is no stacking interface and no
  per-component selection.
- A package may contain a mask, a color treatment, or both. Declaring neither is
  rejected as `empty-effect`.
- Every archive entry must be the manifest or a declared asset. Extra files,
  scripts, `assets` subdirectories and `.gltf`/`.bin`/texture files are
  rejected.
- Declared behaviors are limited to the fields below. New behavior types
  require explicit runtime support; they are not accepted through `extras`.

### Complete annotated example

`fixtures/packages/guard-visor.zip` is a generated, committed sample with this
manifest:

```json
{
  "schemaVersion": 1,
  "id": "shymask.guard-visor",
  "name": "Guard visor",
  "version": "1.0.0",
  "description": "Rigid unlit visor attached to the tracked face, combined with a cool color treatment.",
  "author": {
    "name": "Shymask sample author",
    "attribution": "Generated reproducibly by scripts/build-package-fixtures.mjs",
    "license": "CC0-1.0"
  },
  "mask": {
    "asset": "assets/guard-visor.glb",
    "attachment": {
      "position": [0, 0, 0],
      "rotationDeg": [0, 0, 0],
      "scale": 1
    }
  },
  "colorTreatment": {
    "saturation": 1.15,
    "hueRotateDeg": -8,
    "contrast": 1.05
  }
}
```

The archive is:

```
manifest.json
assets/guard-visor.glb
```

The second committed sample, `fixtures/packages/verdant-tint.zip`, has no
`mask` and only a `colorTreatment`, demonstrating a valid color-only complete
effect.

The third committed sample, `fixtures/packages/rose-visor.zip`, is a mask-only
effect with a **nonzero** `position`, `rotationDeg` and `scale` attachment. The
public check imports it to prove that a nonzero declarative attachment reaches
the renderer (the displayed `diag-effect` attachment is asserted) and that a
mask-only package renders through the same preview/camera path.

Regenerate the committed sample and negative fixtures with:

```powershell
npm run build:packages
```

Validate any archive without opening the app (after `npm run build`):

```powershell
npm run validate:package -- path\to\effect.zip
```

The command prints the structured validation result and exits non-zero when the
package is rejected. It is intentionally the same pure validator the app uses.

## Manifest fields

| Field | Required | Meaning |
| --- | --- | --- |
| `schemaVersion` | yes | Must be the number `1`. |
| `id` | yes | Stable package identity, 2-63 chars of lowercase letters, digits, `.`, `_`, `-`. Re-importing the same id replaces the stored copy. |
| `name` | yes | Display name, 1-80 chars. Shown in the effect selector. |
| `version` | yes | Semantic version core (`1.0.0`). Shown in the selector and diagnostics. |
| `description` | yes | 1-500 chars. Shown in the app's package summary. |
| `author` | yes | `{ name }`; optional `attribution` (≤200), `license` (≤40) and `url` (http/https). Informational only. |
| `mask` | optional | Rigid face-attached mask component (below). |
| `colorTreatment` | optional | Declarative filter parameters (below). |
| `expressionReactions` | reserved | Must be absent or an empty array. A non-empty declaration is rejected as `unsupported-behavior`. |
| `behaviors` | reserved | Reserved for moving parts/secondary motion; absent or empty. Non-empty is rejected. |

Unknown top-level fields and unknown `author` fields produce an `unknown-field`
**warning** (for forward compatibility) but do not enable behavior. Unknown
fields inside `mask`, `attachment` or `colorTreatment` are errors, because a typo
there would silently change the effect.

### `mask`

| Field | Required | Meaning |
| --- | --- | --- |
| `asset` | yes | Archive path `assets/<file>.glb`, exactly one level, ASCII filename. |
| `attachment.position` | optional | Offset from the canonical face origin in **centimetres**, three numbers each in `[-30, 30]`. Default `[0, 0, 0]`. |
| `attachment.rotationDeg` | optional | Euler rotation in **degrees** (three.js XYZ order), each in `[-180, 180]`. Default `[0, 0, 0]`. |
| `attachment.scale` | optional | Uniform scale in `[0.1, 5]`. Default `1`. |

Model the mask around MediaPipe's canonical face origin in centimetres. The
bundled mask and the sample use positive Z for the front of the face (toward the
camera). The mask is attached to the tracked face's facial transformation
matrix — not to screen coordinates — using the same 63° vertical-field-of-view
camera as the bundled mask, so position, rotation and scale are in that space.

The mask asset must be a **self-contained binary glTF 2.0 (`.glb`)**
with triangle meshes (`mode: 4`) and embedded buffers/images (no external URIs).
`KHR_materials_unlit` is supported (the sample mask uses one unlit material so
its colour is exact evidence). GLB features that this runtime cannot execute are
**rejected**, not ignored:

- glTF animations and skins/joints (`unsupported-behavior`) — v1 is a rigid
  attachment;
- cameras and `KHR_lights_punctual` lights (`glb-unsupported-feature`);
- required extensions other than `KHR_materials_unlit`
  (`glb-unsupported-extension`);
- external buffers/images (`glb-external-resource`).

A GLB produced by a Blender export workflow is accepted when it follows those
rules; that authoring flow is issue #9 and is not required for playback.

### `colorTreatment`

All parameters are optional, but at least one must be declared. Every value must
be a finite number in its inclusive range:

| Parameter | Range | Canvas effect |
| --- | --- | --- |
| `brightness` | `0.25`-`2` | `brightness()` |
| `contrast` | `0.25`-`2` | `contrast()` |
| `saturation` | `0`-`3` | `saturate()` |
| `hueRotateDeg` | `-180`-`180` | `hue-rotate()` |
| `sepia` | `0`-`1` | `sepia()` |
| `grayscale` | `0`-`1` | `grayscale()` |

Values outside the range are rejected as `color-parameter-out-of-range`; the app
never clamps an invalid declaration. The filter is applied to the replay frame
before the mask is composited, so a combined effect filters the video and draws
the mask over it. The filter is a fixed expression built from these bounded
numbers — no CSS string is accepted from the package.

## Limits

These are **import-safety caps** (ZIP-bomb, memory and mismatch protection), not
the measured complexity budgets. Issue #11 will set those budgets from measured
authoring output.

| Limit | Value |
| --- | --- |
| Archive bytes | 8 MiB |
| Entries (including ignored directory entries) | 64 |
| Compressed bytes per entry | 4 MiB |
| Uncompressed bytes per entry | 4 MiB |
| Total declared uncompressed bytes | 8 MiB |
| `manifest.json` bytes | 64 KiB |
| Mask asset bytes | 4 MiB |
| Mask attachment position | ±30 cm per axis |
| Mask attachment rotation | ±180° per axis |
| Mask attachment scale | 0.1-5 |

Validation reports `PackageComplexity` measurements (archive/manifest/mask bytes,
entry count, triangle/mesh/material/node/texture counts, declared behavior count,
color parameter count) from the pure validator and in the `validate:package`
output, so #11 can turn measurements into budgets without changing the contract.
No triangle or mesh **threshold** is enforced here. `summary.json` records the
import result messages, which include the complexity subset the app displays
(triangles, meshes, materials and archive bytes), not the full
`PackageComplexity` record.

## Archive safety

The ZIP is parsed by a small pure-JS reader that checks the central directory
before decompressing anything:

- **Zip-slip**: traversal (`..`), absolute paths, drive letters, backslashes,
  empty/`.` segments and control characters are rejected (`entry-path-unsafe`).
- **Symlinks** (Unix external attributes) are rejected (`entry-symlink`).
- **Encryption** and unsupported compression are rejected
  (`entry-encrypted`, `entry-compression-unsupported`).
- **Declared sizes** are enforced before decompression. Deflate output is then
  inflated into a preallocated `cap + 1` byte buffer: fflate never resizes a
  caller-provided buffer, so real output past the cap is clipped instead of
  materialized and the entry is rejected as `entry-too-large`. A central
  directory that understates its size therefore cannot force an unbounded
  allocation. The inflated size and CRC are verified afterwards
  (`entry-too-large`, `archive-unreadable`).
- **Duplicate names** (case-insensitive) and ZIP64 archives are rejected
  (`entry-duplicate`, `archive-unreadable`).
- **Executable/script content** (`.js`, `.mjs`, `.exe`, `.dll`, `.ps1`, `.bat`,
  `.wasm`, `.html`, `.svg`, `.py`, …) is rejected (`executable-content`), even if
  it were reachable another way.
- Only the manifest and the declared `.glb` are extracted, using the shared
  `src/main/safe-path.ts` guard (the same containment check as the local
  `shymask://app/packages/...` asset protocol). Extraction realpath-checks the
  parent directory, so a symlinked `assets` directory cannot write outside the
  package store.

The renderer never receives archive bytes or executable content. It receives
plain validated descriptor data over IPC and fetches only the `.glb` from the
local protocol, which keeps the existing strict CSP and the portable-processing
/ Windows-camera boundary unchanged. All processing is local; there is no
account, telemetry or cloud call.

## Import, selection and removal

1. Press **Import package…** in the Controls panel. The OS file picker opens.
2. The selected ZIP is validated and, if valid, copied into the app's package
   store. The imported effect appears under **Imported packages** in the
   **Effect** selector and is selected.
3. If validation fails, the import is rejected with the first error code, the
   specific field/path and an actionable message. The current effect and output
   are unchanged, and the app does not crash.
4. Selecting a different bundled or imported effect switches the single active
   complete effect. While an imported mask loads, the whole output is the opaque
   **Tracking paused** screen; the previous or raw frame is never shown. If the
   load fails, the output stays hidden with an explanation.
5. **Remove imported effect** removes the selected package from the store. If it
   was active, the effect selector falls back to **No effect**, which is the
   opaque paused output; other imported packages remain.

Packages persist across restarts under Electron's `userData` directory:

```
%APPDATA%\shymask\effect-packages\<package-id>\
    package.zip     the validated archive (revalidated on every launch)
    import.json     local import timestamp and source file name
    assets\...      the declared asset, extracted for the local asset protocol
```

`SHYMASK_PACKAGE_DIR` overrides the store root (the public-workflow check uses an
evidence-local directory so a check run never edits installed packages).

The paused-output policy is unchanged and applies to imported effects exactly as
to bundled ones: startup/not-ready, no effect, manual pause, tracking loss,
multiple faces, unreliable tracking, processing failure, tracking initialization,
and effect switching all replace the whole output in the preview **and** the
virtual camera. Manual pause persists across effect switches. Closing Shymask
stops the camera output. No Blender or AI process is involved in playback.

## Validation error codes

| Code | Meaning / action |
| --- | --- |
| `archive-too-large` | Archive or total uncompressed size over the safety cap; remove media. |
| `archive-unreadable` | Not a readable ZIP, corrupt CRC/structure, encrypted, or unsupported ZIP64; re-export. |
| `entry-count-exceeded` | More than 64 entries; package only the manifest and declared assets. |
| `entry-too-large` | A single entry exceeds the compressed/uncompressed cap. |
| `entry-compression-unsupported` | Only stored and deflate compression are supported. |
| `entry-encrypted` | Encrypted archives are not supported. |
| `entry-duplicate` | Duplicate (case-insensitive) names; keep one entry per file. |
| `entry-path-unsafe` | Traversal/absolute/backslash/control-character path (zip-slip). |
| `entry-symlink` | Symbolic links are not allowed; include regular files. |
| `entry-not-allowed` | A file other than the manifest/declared asset is present. |
| `executable-content` | Script/executable file present; packages are declarative only. |
| `manifest-missing` | No root `manifest.json` (not inside a folder). |
| `manifest-too-large` | Manifest exceeds 64 KiB. |
| `manifest-not-utf8` | Manifest is not valid UTF-8. |
| `manifest-invalid-json` | Manifest is not valid JSON. |
| `manifest-schema-invalid` | Wrong JSON shape, unknown component field, or empty color treatment. |
| `schema-version-unsupported` | `schemaVersion` is not `1`; this build reads v1 only. |
| `identity-invalid` | `id`/`name`/`version`/`description`/`author` invalid. |
| `empty-effect` | Neither a mask nor a color treatment is declared. |
| `unsupported-behavior` | Expression reactions/behaviors, glTF animations or skins are declared; v1 rejects rather than ignores them. |
| `unsupported-asset-type` | Asset is not a single-level `.glb` under `assets/` (for example `.gltf`). |
| `missing-asset` | Declared mask asset is absent or its path is invalid. |
| `color-parameter-out-of-range` | A color parameter is outside its bounded range (or not finite). |
| `attachment-invalid` | Attachment position/rotation/scale is out of range or has unknown fields. |
| `glb-invalid` | Not a valid self-contained GLB 2.0 / no triangle geometry. |
| `glb-external-resource` | GLB references an external buffer/image; embed everything. |
| `glb-unsupported-extension` | A required glTF extension other than `KHR_materials_unlit`. |
| `glb-unsupported-feature` | Cameras, lights, or a non-triangle primitive mode. |
| `unknown-field` | Warning: an unknown top-level manifest field or `author` field is ignored by v1. |

All messages name the field or archive path and the expected form. Multiple
independent issues may be reported; the app shows the first and a count.

Every code in this table is exercised by the unit suite
(`tests/validation-coverage.test.ts` synthesizes the remaining headers/entries)
or a committed negative fixture imported through the public check. The coverage
test fails if a stable code is added without a scenario. The public check
imports the negative fixtures that are practical end-to-end cases; it is not a
claim that every code is represented by a separate committed archive.

## Explicitly unsupported in v1

- Arbitrary executable or script effect code, WASM, HTML/SVG assets.
- Expression reactions, blendshape-driven behavior, animations, skins,
  secondary motion and moving parts. These need explicit runtime support in a
  later schema version.
- Occlusion refinement (the mask is composited over the face; hiding geometry
  behind the face is a later issue).
- Hand-over-mask occlusion, Unreal authoring, Snapchat Lens imports, and
  full strand-level hair simulation.
- `.gltf` plus external `.bin`/textures, Draco/meshopt compression, ZIP64,
  encryption, multiple or nested asset folders.
- More than one complete effect at a time, or combining components from two
  packages (one package can combine its own mask and treatment).
- Physical-webcam or live-human validation of packages; this slice is
  replay-based. Laptop/integrated-graphics behavior is also unverified.
- Final complexity budgets (issue #11). This slice only measures and reports.

## For AI authoring (issue #9)

The authoring harness should produce exactly the archive described above; no
other integration point is needed.

1. Create the mask in Blender (or any glTF tool), then export **binary glTF
   (`.glb`)** with embedded resources. Apply modifiers, use triangle meshes, and
   do **not** include animations, skins, cameras or lights. Keep the mask around
   the canonical face origin, in centimetres, with +Z toward the camera; use the
   manifest `attachment` for any offset/rotation/scale.
2. Write `manifest.json` with `schemaVersion: 1`, a stable lowercase `id`, a
   semantic `version`, a description and author attribution. Declare `mask`
   and/or bounded `colorTreatment` parameters.
3. Zip only `manifest.json` and the declared `assets/<file>.glb` (one level, no
   extra files). Keep it kilobytes where possible.
4. Run `npm run validate:package -- <file.zip>` (or import it in the app) and
   fix every reported code before handing the package to a creator. Warnings are
   advisory; errors block import.
5. Do not generate executable code, scripts, expression/animation declarations,
   or effect logic. New capabilities must be added to the runtime and this
   contract first (ADR-0004).

A package that passes validation renders through the same
`src/core/pipeline.ts` path as the bundled mask and color treatments, so if it
works in the imported preview it works in the virtual camera. The
`PackageComplexity` measurements in the validation result are the intended input
for #11's complexity budgets.

## Validation and evidence

- Unit tests: `npm test` covers schema/version rejection, color bounds, archive
  safety (zip-slip, absolute paths including directory entries, symlinks,
  duplicates, oversized declared entries, a lying-size inflate bomb, CRC and
  corruption, encryption and unsupported compression), GLB feature rejection
  (including missing accessor `componentType`/`type`), effect resolution,
  nonzero mask attachment conversion, and the extended output policy. Every
  stable validation code is asserted by `tests/validation-coverage.test.ts`.
- Public workflow: `npm run check` scenario I imports the generated samples
  through the **Import package…** control (only the OS file picker is stubbed in
  the main process; validation, storage, extraction, the local asset protocol and
  GLTFLoader parsing are the real paths), verifies preview and independent
  camera-consumer frames contain the packaged mask/color treatment, verifies a
  mask-only package with a nonzero attachment, switching/manual-pause/tracking
  gates, rapid double switching, rejects the negative fixtures with actionable
  codes, and verifies removal and restart persistence.
- Evidence (screenshots, camera PNGs, `summary.json`, logs) is written under the
  gitignored `evidence/check-<timestamp>/` directory; `summary.json` contains the
  tested head SHA, the import result messages (which include the displayed
  complexity subset: triangles, meshes, materials and archive bytes), the
  negative-import results, and the rapid-switch/attachment evidence.

Sample packages are generated deterministically by
`scripts/build-package-fixtures.mjs` (a small procedural GLB writer plus fixed
timestamp/deflate ZIPs), not hand-waved binaries. They are **not** Blender
output; they exercise the contract that the #9 Blender/AI flow must satisfy.

[issue #9]: https://github.com/rtfa1/shymask/issues/9
