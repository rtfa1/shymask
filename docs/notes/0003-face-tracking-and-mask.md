# Face tracking and the basic rigid mask (issue #4)

This note records the tracker/rendering choice, the recovery thresholds, the
model provenance and the measured replay-based behavior for the one-face
tracking slice. It is deliberately scoped to recorded video: no physical camera
or human participant is used, and the numbers below are not a performance-target
claim.

## What was built

- **One tracked face.** The renderer runs MediaPipe Face Landmarker in VIDEO mode
  with `numFaces: 2` so the policy can distinguish exactly one face from more
  than one. A detected face is accepted only when it is plausible (landmark
  count, transform validity, face scale and per-frame pose continuity).
- **Rigid 3D mask.** A procedural low-poly helmet/visor built from Three.js
  primitives, attached to the face's facial transformation matrix (not to screen
  coordinates) and rendered into an offscreen WebGL canvas. The pipeline
  composites that canvas into the single 1280x720 output canvas with `drawImage`,
  so the preview and the virtual camera still consume exactly one frame path.
- **One policy.** `src/core/output-policy.ts` remains the only output decision
  point. Tracking readiness/loss gates every selected effect, including the
  existing color treatments. Manual pause is evaluated before tracking, so
  automatic recovery cannot override it.
- **Diagnostics.** The public diagnostics and the diagnostic injection control
  expose the tracking phase, the latest sample classification, face/landmark
  counts, thresholds, inference timing, mask origin/pose/probe and the model
  checksum. The injected states are labelled `injected=true`; the real detector
  is authoritative when the control is on `Use detected face (normal)`.

## Tracker choice

**MediaPipe Face Landmarker** (`@mediapipe/tasks-vision` 0.10.21, pinned exactly)
with the WASM runtime and the `float16` model bundle v1, using the GPU delegate.
Reasons:

- It provides 478 face landmarks plus an optional facial transformation matrix,
  which is exactly the rigid pose this slice needs (no custom landmark-to-pose
  fitting).
- It runs locally in the renderer with no account, cloud call, or native code,
  preserving the portable-processing / Windows-camera boundary.
- The model and WASM are small enough to fetch on demand and stage locally.

**Why not a hand-rolled detector?** A 3D pose estimate from landmarks would need
a canonical model and a solver, adding a second area of unverified behavior for
no benefit over the model's own matrix.

**Why a second Three.js surface?** The mask needs a real 3D projection and
composited layers. Three.js keeps the geometry/pose code small and explicit, and
`drawImage` into the existing output canvas keeps the camera publication path
unchanged. The WebGL canvas is offscreen and transparent; the 2D canvas remains
the only frame source.

### Rendering calibration

- MediaPipe's transformation matrix is **column-major** (translation in
  elements 12-14, canonical face units in centimetres).
- The mask scene uses `PerspectiveCamera(63, 16/9, 1, 10000)` at the origin with
  the matrix applied directly to the object. 63 degrees is MediaPipe's
  `face_geometry` vertical-FOV assumption, and it is what makes the mask land on
  the face (verified against the landmark bounding box: mask origin within a few
  pixels of the face centre on the default clip).
- Pose diagnostics decompose the same matrix in YXZ order and report
  yaw/pitch/roll in MediaPipe camera space. The renderer consumes the matrix
  directly, so these angles are diagnostics/evidence, not a scene conversion.
- The cyan eye plate is an opaque exact-colour probe: the public check reads the
  output-canvas pixel at the projected eye point and the camera PNG at the same
  point, which proves the mask is composited rather than merely drawn near the
  face.

## Thresholds and recovery policy

| Parameter | Value | Rationale |
| --- | --- | --- |
| `minFaceDetectionConfidence` | 0.5 | MediaPipe default |
| `minFacePresenceConfidence` | 0.5 | MediaPipe default |
| `minTrackingConfidence` | 0.5 | MediaPipe default |
| Minimum landmark count | 400 of 478 | Rejects partial/degenerate detections |
| Plausible face width | 0.04-0.95 of frame width | Rejects tiny/huge false positives |
| Maximum pose jump per frame | 30 cm / 60 degrees | Rejects teleporting/implausible fits |
| Lost grace | 250 ms | About 5-7 presented frames at the observed ~21-24 Hz replay pacing; absorbs a single dropped detection at a loop seam without flashing the paused screen |
| Unreliable confirmation | 250 ms | A face that is present but implausible must stay implausible before pausing |
| Recovery confirmation | 300 ms | Prevents flapping between processed frames and the paused screen |
| Consecutive inference errors | 5 | Turns repeated detector failure into the persistent hidden-output error |

- **Multiple faces pause immediately.** A second person is never published, so
  there is no confirmation delay for that state. If the second face leaves and
  then no face is detected, the phase moves to `lost` after the grace window so
  the explanation says "no face was detected" instead of claiming that more than
  one face is still visible. If the second face leaves but the remaining face is
  unreliable (for example too few landmarks), the phase moves to `unreliable`
  after its confirmation window, so the explanation describes the actual problem
  instead of claiming that more than one face is still visible. The output stays
  hidden throughout.
- **Recovery is automatic** once exactly one reliable face has persisted for the
  recovery window, unless the operator paused manually.
- **The pose-jump guard is scoped to continuous tracking.** The jump reference is
  seeded by a reliable sample observed while the phase is `tracking` (and by the
  sample that completes recovery); no reference is kept during the paused
  recovery window, so one outlier first-recovery sample cannot reject every
  healthy sample after it and latch the guard. While `tracking`, a single
  implausible jump (more than 30 cm or 60 degrees in one sample) is classified
  `unreliable` and the mask renderer does not project its matrix: the last
  accepted projection is reused through the 250 ms unreliable confirmation
  window, so a detector glitch cannot draw one teleported mask frame. When the
  phase leaves `tracking` (lost, unreliable or multiple faces), the pre-loss pose
  reference is discarded: a person who legitimately turned while the output was
  paused must be able to reacquire through the normal recovery window (issue #4,
  AC3).
- **Readiness before first detection:** the policy has an `initializing` phase
  and hides the output with "tracking is starting" until the first confirmed
  face.
- The Tasks JS result does **not** expose a per-face confidence value. The
  app-level reliability gate therefore uses the observable signals above in
  addition to the model's internal confidence thresholds. This is recorded as a
  limitation: not every tracking or rendering defect is detectable.

## Model provenance and failure behavior

| Field | Value |
| --- | --- |
| Model | MediaPipe Face Landmarker, `float16`, model bundle v1 |
| Source | `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task` |
| Runtime | `@mediapipe/tasks-vision` 0.10.21 (WASM, GPU delegate), Apache-2.0 |
| License | Apache-2.0 |
| Bytes | 3,758,596 |
| SHA-256 | `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff` |

- `npm run fetch:tracker` downloads into the gitignored `.cache/tracker/`,
  verifies the committed byte count and SHA-256, and refuses to replace a file on
  mismatch. `scripts/build.mjs` stages the verified model and the WASM fileset
  into `dist/renderer/tracker/`.
- At launch the main process re-validates the staged model and all WASM files
  (`src/main/tracker.ts`). A missing model, missing runtime file, wrong size or
  wrong checksum produces an actionable hidden-output error and a disabled
  Start. The output is the opaque "Tracking paused" screen; there is deliberately
  **no camera fallback** anywhere in this path.
- A tracker/model load failure in the renderer (for example WebGL2 unavailable)
  is reported the same way, with the recovery command in the status area.

## Asset-loading boundary

The renderer, WASM fileset, model and replay media are served from a local
`shymask://app/...` protocol (`src/main/asset-protocol.ts`) rather than `file://`.
This is what allows the strict CSP (`default-src 'none'`, `script-src 'self'
'wasm-unsafe-eval'`, `connect-src 'self'`) to keep working while the Fetch API
loads the WASM/model, and it gives the replay `<video>` byte-range support for
seeking. Byte ranges support `start-end`, `start-` and the suffix form `-N`
(the last N bytes); an end past the file size is clamped to the last byte and an
unsatisfiable range gets 416. Only the build output, tracker directory and
fixture directory are reachable; traversal is rejected, and a symlink is
rejected when its resolved real path leaves its configured root. No network
listener or Windows API is added to the portable path.

## Measured behavior (replay-based, this development desktop)

- **Hardware:** 11th Gen Intel Core i7-11700K (8 cores / 16 logical), NVIDIA
  GeForce RTX 3070 Ti, 31.8 GiB RAM, Windows 11 Pro 10.0.26100. Node.js 24.19.0,
  Electron 45.3.1.
- **Default fixture (`webcam-loop-v1`, 3.379 s):** one face, 478 landmarks in
  every sampled frame. In the check's ~2.5 s sample the mask origin moved about
  7 px horizontally and 3 px vertically (a longer manual sample saw about 12 px
  horizontally and 23 px vertically, depending on the clip phase); yaw varied
  about 3.5 degrees and pitch about 2.1 degrees. This is real but small recorded
  motion; the clip has no large turns or nods.
- **Recorded motion fixture (`pose-loop-v1`, 49.628 s, CC0 Wikitongues clip):**
  the 8 s window starting at 41.6 s produced a yaw range of ~28.8 degrees (26.9
  in another run), pitch ~29.1 degrees, roll ~18 degrees and mask-origin movement
  of ~99 x 64 px, with 18/18 sampled frames tracked. The mask stayed attached to
  the face in every tracked sample. This is the turns/nods/leaning evidence for
  AC1.
- **Tracker inference:** steady-state p95 ~13.6 ms per presented frame (11-14 ms
  across runs); the first inference after model creation paid a warm-up of
  ~0.30 s in the validated run and ~2.0 s in another (GPU/driver warm-up), and is
  reported separately so it is not confused with steady-state cost.
- **Mask render + composite:** the mask scene render itself is ~0.1 ms; the
  measured render+composite+diagnostics p95 in the check was 11.4 ms (the same
  measurement includes the canvas draw and the 16x9 mean-RGB sample).
- **Paused output:** every tracking-loss/multiple-face/unreliable/model-failure
  state was measured as the exact dark paused canvas in both the preview and the
  independent camera consumer (mean RGB about 12,15,20).

No performance target is claimed. Laptop integrated-graphics behavior, physical
cameras, call applications and live-human acceptance remain later slices.

## Known limitations

- The recorded fixtures are replay only; no physical-camera or live-human
  tracking evidence exists in this slice.
- The mask is rigid and has no occlusion refinement or secondary motion; those
  are issues #6 and later.
- Multiple faces are exercised by a labelled diagnostic injection in the
  public-workflow check. The real detector is configured with `numFaces: 2`, and
  the policy is the same one the injection drives, but real two-person footage is
  not part of this slice.
- The app cannot detect every visual defect (for example a technically valid but
  visually wrong landmark fit). The model's own confidence gates and the
  plausibility checks above reduce, but do not eliminate, that risk. The mask
  projection uses those same app-level plausibility checks; the Tasks JS result
  does not expose a per-sample model confidence value to gate it separately.
- A rejected sample keeps the previous accepted projection for up to the 250 ms
  unreliable confirmation window, so if the person moves faster than the
  per-sample jump limit the mask can lag the face for those frames before the
  paused output takes over. That is the deliberate trade-off that stops a
  detector glitch from teleporting the mask.
- The first sample that completes recovery is checked for plausibility but is
  not compared with the pre-loss pose, because the person may legitimately have
  moved while the output was paused. If that exact sample were a detector
  outlier, it would define the first restored frame; the samples after it are
  continuity-checked again.
- WebGL2 and the GPU delegate are assumed. A machine without them shows the
  actionable hidden-output error instead of a fallback.
