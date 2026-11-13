# Effect packages and import (issue #5)

This note records the schema/validation choices and the replay-based evidence for
the validated-effect-package slice. The creator-facing contract lives in
[`docs/effect-packages.md`](../effect-packages.md); the decision to accept
declared assets/behaviors rather than executable effect code is
[ADR-0004](../adr/0004-declarative-effect-packages.md). No physical webcam,
human participant, Blender process or AI harness is used here.

## What was built

- **Schema v1** (`src/core/effect-package-contract.ts`): a ZIP containing a root
  `manifest.json` (`schemaVersion: 1`) and a declared `.glb` mask asset under
  `assets/`. A package is one complete effect: a mask component and/or a
  declarative color treatment. Identity, author/attribution, description,
  attachment transform, bounded color parameters and reserved behavior fields
  are typed and documented.
- **Pure validation** (`src/core/effect-package.ts`, `src/core/zip.ts`,
  `src/core/glb.ts`): no Electron/Node I/O. The ZIP reader parses the central
  directory first, rejects traversal/absolute/backslash/control paths, symlinks,
  encryption, unsupported compression, duplicate names, ZIP64 and declared
  oversized entries before decompressing, then verifies inflated size and CRC.
  The GLB inspector requires a self-contained glTF 2.0 binary with triangle
  geometry and rejects external resources, unsupported required extensions,
  animations, skins, cameras and lights. Every failure is a structured
  `{ severity, code, message, path? }`; unknown top-level manifest fields are
  warnings.
- **Persistent store** (`src/main/effect-packages.ts`): imports are validated,
  then stored as `package.zip` + extracted declared assets + `import.json` under
  Electron `userData/effect-packages/<id>`. The archive is revalidated on every
  launch (tamper detection with one validator). The store is reachable at the
  local `shymask://app/packages/<id>/assets/...` protocol route; only validated,
  declared `.glb` bytes are served, never archive or executable content.
- **Import UX**: an **Import package…** control opens the OS dialog; the result
  (success, actionable rejection, cancellation) is shown in the app. Imported
  effects appear under an **Imported packages** optgroup in the single **Effect**
  selector and are removed from the store with **Remove imported effect**. The
  renderer receives plain descriptor data over IPC.
- **One rendering path**: `src/renderer/mask-renderer.ts` loads the package GLB
  with Three.js `GLTFLoader` into the same mask scene/camera as the bundled
  procedural mask, applying the manifest attachment. The mask is composited into
  the same output canvas by `src/core/pipeline.ts`, which is what the virtual
  camera publishes. A combined effect filters the replay frame with the declared
  treatment and draws the mask over it.
- **Switching policy**: selecting an imported mask starts an async load and
  immediately paints the opaque "Tracking paused" screen (`effect-switching`);
  stale switches are cancelled by a token. A load failure leaves the output
  hidden with an explanation (`effect-unavailable`). Manual pause outranks
  switching and persists. Unknown/stale selections fall back to explicit
  `no-effect` (`effect-invalid`), never raw passthrough.
- **Reproducible fixtures**: `scripts/build-package-fixtures.mjs` writes the
  sample packages (`guard-visor`, `verdant-tint`) with a deterministic
  procedural GLB writer and fixed-timestamp/deflate ZIPs, plus one negative
  package per error code. `npm run validate:package -- <zip>` exposes the same
  validator to creators and the later AI harness.

## Why these choices

- **ZIP + `fflate`**: pure JS, no native dependency, deterministic fixtures, and
  a format creators already produce. We do not call a general extractor: the
  central-directory reader is small, auditable and enforces traversal, symlink
  and size safety before decompression.
- **GLB only**: self-contained (no external buffer/image paths to resolve or
  sandbox) and the natural Blender binary export. `.gltf` + `.bin`/textures is a
  later contract extension, not silently accepted.
- **Declarative color parameters, not CSS**: the app builds the filter string
  from bounded numbers, so a package cannot inject style or script.
- **Reject unsupported behavior**: expression reactions, glTF animations and
  skins are declared reserved and rejected when non-empty. Silently ignoring
  them would make a package look accepted while behaving differently.
- **Keep the bundled and imported paths identical**: the package mask is just
  another three.js scene in the existing mask renderer, so preview and virtual
  camera cannot diverge and the tracked-face transform/probe evidence still
  applies.

## Complexity seams for issue #11

`validateEffectPackage` returns `PackageComplexity` (archive/manifest/mask bytes,
entry count, triangle/mesh/material/node/texture counts, declared behaviors,
color parameters). The import result and `summary.json` include it. The only
enforced numeric caps are import-safety bounds (ZIP-bomb/memory) and the
bounded color/attachment ranges; **no triangle/mesh threshold is asserted**.
Issue #11 can set budgets from measured authoring output without changing the
contract.

## Evidence (replay-based, this development desktop)

Covered by `npm test` and `npm run check` scenario G:

- Valid `guard-visor.zip` imports through the public control, appears in the
  selector and renders its package GLB mask plus declared color treatment in the
  preview and in an independent Media Foundation camera-consumer PNG. The
  package's unlit material colour (`e11d9a` → RGB 225,29,154) is the exact probe:
  the preview pixel at the mask probe and the camera PNG pixel match, so the
  packaged asset (not just the bundled mask) is composited through the shared
  path.
- Valid `verdant-tint.zip` (color only) renders its green-shifted treatment in
  preview and camera.
- Switching bundled → imported → imported paints the paused output first
  (`switchingPausedFrames` increments) and completes; manual pause persists
  across the switch and the camera stays on the paused canvas; tracking loss
  hides the imported effect and recovery is automatic.
- The negative fixtures (malformed JSON, schema v2, unsupported behavior,
  missing asset, invalid color, zip-slip, oversized entry, executable file,
  unsupported glTF extension) are each rejected with their documented code,
  keep the previous effect rendering, and produce no renderer console errors.
- Removing the active imported effect falls back to the no-effect opaque paused
  output in preview and camera; another imported package survives an app restart
  and still renders.
- `npm run vcam:check` and the pre-existing public-workflow checks remain green.

The numbers in `summary.json` are replay-derived. They do not establish
physical-camera behavior, call-application compatibility, laptop/integrated-
graphics suitability, or the final 720p/30 FPS / ≤100 ms target. The sample
packages are generated fixtures, not Blender output (#9).

## Known limitations

- v1 masks are rigid: no occlusion refinement, moving parts, secondary motion,
  expression reactions or skinning. Those require later runtime support.
- Embedded textures are permitted by the GLB validator (self-contained), but the
  committed samples do not exercise them; texture handling is GLTFLoader's
  standard path.
- The mask evidence probe is the projected bounding-box centre and the first
  material colour; a mask whose centre is not solid geometry would need a
  different evidence strategy (the check would not find the exact colour).
- Import cancellation is handled in the app but not driven by the public check;
  unknown-effect fallback and manual-pause precedence are unit-tested, while the
  removal path is exercised end-to-end.
- The package store is per-user `userData`; the check uses an isolated directory.
  No signing, trust store, sandboxing of GLB parsing beyond the structural
  validator, or multi-user separation is implemented. This is a local
  single-user prototype, matching the virtual-camera trust boundary.
