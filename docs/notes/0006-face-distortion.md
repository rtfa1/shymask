# Bounded, face-following distortion (issue #7)

This note records the schema-v2 face-distortion contract, the fixed runtime warp,
the paused-output behavior, the replay-based evidence and the measured limits.
It follows [note 0004](0004-effect-packages.md) (package contract and import) and
[note 0005](0005-face-occlusion-and-anchoring.md) (tracking, occlusion and pose
smoothing). All evidence here is from recorded replay input and the Windows
virtual camera on the development desktop; no physical webcam or human
participant was used.

## What was built

### Contract: schema v2, additive and deliberately versioned

Schema version 2 adds one optional component:

```json
"faceDistortion": {
  "mode": "bulge",
  "strength": 0.6,
  "radiusScale": 1.35,
  "centerOffset": [0, 0]
}
```

| Field | Required | Bound |
| --- | --- | --- |
| `mode` | yes | `"bulge"` or `"pinch"` |
| `strength` | yes | `0`-`1` |
| `radiusScale` | no (default `1`) | `0.25`-`2.5` |
| `centerOffset` | no (default `[0,0]`) | each axis `-0.5`-`0.5` |

The contract is intentionally the **smallest** declarative form that expresses a
face distortion: a mode, a bounded strength, and a face-relative warp ellipse.
It does not accept a distortion mesh, shader, per-frame function or executable
code. The fixed runtime multiplies `strength` by `0.75`, so the displacement at
the ellipse centre is bounded even at maximum strength.

**Why a schema version bump rather than extending v1?** An older v1-only build
treats unknown top-level fields as warnings. If `faceDistortion` were added to
v1, that build would import a package combining a mask and a distortion, warn
about an unknown field, and render only the mask — a silent behavior change.
Bumping to v2 makes an older build reject the package with the existing
`schema-version-unsupported` code, and this build rejects a v1 manifest that
declares `faceDistortion`. Existing v1 packages remain valid unchanged; a v2
manifest without `faceDistortion` is also valid.

Invalid declarations produce the new stable code `distortion-invalid` with the
field path and actionable text; a v1 declaration produces
`schema-version-unsupported` naming the required version.

### Runtime: fixed radial shader driven by the tracked face box

`src/core/face-distortion.ts` maps the tracked face box and the validated
parameters to a normalized ellipse and a signed warp factor. The renderer
recomputes it on every processed frame:

- centre = face box centre + `centerOffset` × face box size;
- radii = `radiusScale` × half the face box width/height;
- signed factor = `mode === bulge ? +1 : -1` × `strength` × `0.75`.

`src/renderer/face-distortion-renderer.ts` uploads the current replay frame as a
texture to a small offscreen WebGL canvas and applies one fixed fragment shader:

```
scale = 1 - warpFactor × (1 - r²)²      (r < 1, inside the ellipse)
uv'   = ellipseCentre + (uv - ellipseCentre) × scale
```

A positive factor samples closer to the centre (bulge/magnify); a negative
factor samples farther out (pinch/shrink). Outside the ellipse the shader
returns the untouched source pixel, so the distortion is confined to the face
region and blends continuously into the rest of the frame. There is no
package-supplied shader, mesh or code path.

The offscreen canvas is **not** a second publication path. `src/core/pipeline.ts`
draws it as the processed frame through the same single 1280×720 output canvas,
then applies the declarative color treatment and composites the mask overlay.
The preview and the virtual camera both consume that one canvas.

### Paused-output behavior

The distortion is a normal effect component, so it is gated by the existing
single output policy before any frame is drawn:

- startup/not-ready, no active effect, manual pause, tracking loss, multiple
  faces, unreliable tracking, effect switching, an invalid/unresolved selection,
  a failed effect or a processing failure all replace the whole output with the
  opaque **Tracking paused** screen.
- If the distortion renderer or an accepted tracked face box is unavailable, the
  frame is not drawn; the caller keeps the previous processed frame briefly and
  then the policy hides the output. There is no branch that draws the raw replay
  frame.
- Removing the active distortion package falls back to **No effect**, which is
  the opaque paused screen. Selecting **No effect** does the same. Switching
  away to a mask package paints the paused screen while the mask loads.
- **WebGL context loss** marks the distortion renderer non-drawable instead of
  letting three.js silently return from `render()`. The processed-frame path
  then returns false, the existing 250 ms undrawable guard hides the whole
  output in preview and camera, and no stale or raw frame is composited. The
  public diagnostic control injects the loss with `WEBGL_lose_context`; the
  extension is cached before the loss (WebGL returns null from `getExtension()`
  once a context is lost), so unchecking can request a browser restore. A
  restored context re-initialises three.js and the effect resumes; a context
  the browser refuses to restore stays hidden.

### Diagnostics

The public **Face distortion** diagnostic reports:

```
active=true mode=bulge strength=0.6 radiusScale=1.35 centerOffset=0,0
warpEnabled=true drawable=true contextLost=false
faceX=... faceY=... faceW=... faceH=...
centerX=... centerY=... radiusX=... radiusY=...
costMsLast=... costMsP95=...
warpDelta=... changedInsidePct=... changedOutsidePct=...
```

`warpDelta`, `changedInsidePct` and `changedOutsidePct` come from two 64×36
passes over the **same uploaded frame texture**: one identity blit and one
warped pass. Because both use the same texture and resolution, the
outside-ellipse difference is zero apart from GPU rounding and the inside
difference is the warp itself. That makes it a useful, deterministic
**diagnostic**, but it is not published-output proof: it compares the
renderer's own identity and warp passes, so a pipeline that dropped the warp
after this comparison (or a warp applied to a texture the preview never shows)
would still pass it. The published-output proof is the separate A/B below.

The diagnostic's `faceX/faceY/faceW/faceH` are the renderer's own input. The
check therefore asserts the ellipse against the independent `diag-face` face
box (populated from the detector's `faceBbox`) with a small rounding tolerance;
the motion samples use the same cross-check.

### Published-output A/B

The check holds a documented frame, keeps the distortion effect selected, and
uses the public **Apply face-distortion warp (diagnostic A/B)** control. Turning
it off draws the same uploaded frame through the identity shader, so the output
still comes from the effect renderer canvas, not the raw video element, and
every paused-output rule still applies. Exact 1280×720 ON and OFF PNGs are
captured through the public **Capture evidence frame** control and compared:

- the change is substantial and sits inside the ellipse derived independently
  from `diag-face` and the manifest's `radiusScale`/`centerOffset`;
- it is ~zero outside that ellipse;
- two ON captures and two OFF captures of the same held frame are
  pixel-identical (0 self-diff), so the comparison is not video drift;
- the independent Media Foundation camera receives the identical change; and
- the A/B is repeated at a second documented held pose with a different face
  position; the changed-region centroid must move with the face.

A regression that drops the warp makes ON == OFF. A fixed screen-space overlay
is excluded by the cross-pose centroid gate, not by ellipse containment: the
two tracked ellipses overlap, so a fixed point can be inside both. The check
requires the changed-region centroid to move at least 40 px and at least 50% of
the face-box movement between the two documented poses; a fixed overlay cannot
satisfy that. This is stronger than the offscreen warp delta and is reported as
the published-output evidence.

## Evidence (replay-based, this development desktop)

Covered by `npm test` and `npm run check`:

- Unit coverage (`tests/face-distortion.test.ts`,
  `tests/effect-package.test.ts`, `tests/effects.test.ts`,
  `tests/output-policy.test.ts`, `tests/validation-coverage.test.ts`): the
  committed schema v2 sample validates; v1 packages still validate; v1 +
  `faceDistortion` is rejected; invalid mode/strength/radius/offset/unknown
  field are rejected as `distortion-invalid`; optional fields default; the warp
  ellipse follows the face box translation and scale, respects `centerOffset`,
  and reverses for pinch; the pure mapping clamps out-of-bounds input; the
  drawability predicate is false for a disposed or context-lost renderer (the
  WebGL integration itself is exercised through the public injection below).
- Scenario I (default recorded clip) imports `face-distortion.zip` through the
  public **Import package…** control, selects it automatically, asserts the
  active distortion diagnostic against the independent `diag-face` box, captures
  a processed preview PNG plus an independent Media Foundation camera PNG, runs
  the held-frame warp ON/OFF A/B in preview and camera, injects a WebGL context
  loss and asserts the hidden output plus recovery after a browser restore, and
  exercises every paused-output case (manual pause, tracking loss, multiple
  faces, processing failure, switching, no-effect and removal). Manual pause,
  tracking loss, multiple faces, processing failure, context loss, no-effect and
  removal are camera-captured in preview and the independent camera; switching
  is asserted by the public `switchingPausedFrames` counter and status text
  (the six other paused states are the captured ones). It also rejects the four
  distortion negative fixtures with their
  documented codes and keeps the previous effect rendering.
- Scenario G (recorded `pose-loop-v1` clip, documented 8 s turn/nod/lean
  window): the warp ellipse's centre follows the tracked face box and moves at
  least 30 px across the window; each sampled frame passes the independent
  `diag-face` geometry check and the inside/outside pixel-change gates; three
  screenshots are saved. It then runs the published-output A/B on the held
  47.7 s pose (preview and camera) and repeats it on the opposite 16.0 s pose,
  asserting that the changed-region centroid moves with the face.
- Timing (default clip, replay-derived): the main-thread warp submission time,
  the full render/composite cost and the presented-frame interval are recorded
  while the distortion is active, with a color-only package on the same fixture
  as the baseline. Submission time is `performance.now()` around
  `renderer.render()` only, with no GPU sync/readback; the render-cost and
  frame-interval differences are sequential-window observations, not isolated
  distortion costs. These are observations for the later complete-effect
  benchmark (#10/#11), not a performance target.

### Measured values (replay-based, this run)

Hardware and source are the same development desktop and fixtures as note 0005
(i7-11700K, RTX 3070 Ti, 31.8 GiB, Windows 11 Pro 26100; MediaPipe Face
Landmarker 0.10.21 GPU delegate; Three.js 0.180.0). The distortion sample is the
415-byte `fixtures/packages/face-distortion.zip` (1 entry, 496-byte schema v2
manifest, no mask asset). The cited run is
`evidence/check-2026-11-13T21-25-31-655Z/summary.json` at code head
`0e0e1a8c6e417ff73b6f14de83afc48735788746` (83/83 checks); all values below are
from that run unless marked as earlier-run observations. The final head
`e868fa608d5a3664e6a4aef12cfd4fd1ca3be124` adds documentation-only commits
after that code head, and its own complete run
(`evidence/check-2026-11-13T21-36-47-057Z/summary.json`) also passes 83/83 with
slightly different per-run pixel counts; `evidence/logs/check-final.log` is that
final-head run:

| Measurement | Value |
| --- | --- |
| Default-clip offscreen warp change (diagnostic) | 72.5% of inside-ellipse samples changed, 0.0% outside, warp delta 0.86 (0-255 mean absolute); earlier runs 68.9–72.5% |
| Distortion preview PNG | exact 1280×720 captured output, non-paused (mean RGB 140,51,43 for the PNG; live mean 143,53,45) |
| Distortion camera PNG | independent Media Foundation consumer mean 139,51,46; matched the preview within the check's tolerance (captured PNG mean 138,51,45) |
| Main-thread warp submission, p95 | 0.4 ms at 1280×720 (rolling p95 after warm-up). `performance.now()` around `renderer.render()` only: no GPU sync or readback, so the GPU/compositor cost is not included |
| Render + composite + diagnostics, p95 | 14.6 ms, with the color-only baseline 14.0 ms on the same fixture (observed sequential delta 0.6 ms); earlier runs 14.9–15.4 ms vs 13.8–15.1 ms. Not an isolated distortion cost |
| Presented-frame interval, p95 | 69.5 ms vs 48.7 ms in the cited run's sequential 2.2 s windows (observed delta 20.8 ms); earlier runs 62.5–76.5 ms vs 48.7–56 ms. The windows are not isolated, so the delta is reported as observed run variation, not attributed added cost |
| Published-output A/B, default clip | held 1.5 s frame: 32,036 changed pixels, 100% inside the independent `diag-face` ellipse, 0 outside; two ON and two OFF captures each 0 self-diff; camera PNG changed by the identical 32,036 pixels |
| Recorded-motion window | 18/18 samples tracked on `pose-loop-v1` (enforced ≥12 of 18); warp centre moved 93×68 px with the face box; inside-ellipse change 55.7–71.6% (every sample passes the ≥8% inside / ≤3% outside gates) |
| Published-output A/B, two poses | held 47.7 s: 62,236 changed pixels (100% inside the independent ellipse, 0 outside); held 16.0 s: 62,763 changed pixels (100% inside, 0 outside); camera identical to preview and 0 same-state self-diff at both; changed-region centroid moved 117.8 px with a 108.2 px face move |
| Paused-output camera captures | manual pause, tracking loss, multiple faces, processing failure, context loss, no-effect and removal all delivered the opaque paused canvas (mean ≈ 12,15,20) |
| WebGL context loss | diagnostic `drawable=false`, `contextLost=true`; opaque paused output in preview (10,13,18) and camera (12,15,20); browser restore returned `drawable=true` and the effect resumed (preview 143,54,47) |

The offscreen inside/outside split is a deterministic diagnostic, not the
published-output proof. The distinction matters: the same-frame comparison uses
the renderer's own identity and warp passes, so it cannot by itself show that the
preview and camera received the warp. The published-output proof is the A/B:
with the effect still active, the identity pass removes only the warp term, and
the exact 1280×720 ON/OFF PNGs differ by tens of thousands of pixels, all inside
the independently derived tracked-face ellipse and none outside, with zero
same-state self-diff and an identical camera change. Across two documented poses
the changed region moved with the face. The pixel-change metric is not a visual
quality score; the saved PNGs show the resulting frames. The A/B proves a
localized published change and a face-relative changed-region centroid; it is
not a measurement of the radial displacement kernel, and OFF provenance rests on
the effect-selection assertions and the renderer code path.

See the measured values in the run's `summary.json`. The default-clip A/B,
preview/timing/context-loss data and `timingBaseline` are under
`effectPackages.faceDistortion.evidence` (including `ab` and `contextLoss`);
the two-pose A/B, opposite-pose A/B, centroid comparison and motion samples are
under `effectPackages.faceDistortion.motionFollowing` (including `ab`,
`abOpposite`, `faceFollowingPoses`, `samples`, `centerXRange`, `centerYRange`).
`evidence/logs/check-final.log` is the final-head run described above.

## Supported limits and remaining limitations

- **Two whole-face modes only.** `bulge` and `pinch`, one radial ellipse. There
  is no per-landmark or per-expression warp (separate eyes/mouth), no 3D mesh
  deformation, no animated/time-varying displacement, and no package-supplied
  shader or geometry. Those need explicit runtime support in a later schema.
- **Screen-space sampling, face-box placement.** The warp follows the tracked
  face box's position and size; it does not use the face orientation to rotate
  the warp or deform in 3D. The face box itself changes under yaw, so the
  ellipse position/size is a tracked proxy, not a surface mesh.
- **Recorded coverage.** Motion evidence covers the documented ~8 s window of
  `pose-loop-v1` (roughly 24-29° yaw, 23-35° pitch, 12-19° roll at this
  framing). Faster or more extreme poses are untested.
- **Replay only.** No physical-camera or live-human evidence exists in this
  slice; camera-sensor latency, call-application compatibility and real
  Zoom/Meet/OBS behavior remain for final live acceptance.
- **Desktop only.** Measured on the RTX 3070 Ti development desktop; laptop
  integrated-graphics behavior is unverified.
- **Not a benchmark.** The timing numbers are main-thread measurements on a
  recorded clip with a virtual camera. The 0.4 ms figure is WebGL submission
  time only (no GPU sync/readback); the render-cost and frame-interval deltas
  are sequential-window observations. They do not establish the parent spec's
  720p/30 FPS / ≤100 ms target, and they exclude a target call/stream
  application.
- **Failure coverage.** Context loss is injected with `WEBGL_lose_context`; a
  real driver/GPU reset is not reproduced, and a context the browser refuses to
  restore stays hidden until the tracker renderer is rebuilt. Effect-switch
  pauses are asserted by the public `switchingPausedFrames` counter and status
  text; a separate camera capture while a switch is in flight is not taken
  (the same shared output policy and the camera paused captures in the other
  states cover the camera path). A combined mask+distortion package is supported
  by the contract and unit-tested through effect resolution, but this slice has
  no committed combined sample or end-to-end check for it.
- **Policy unchanged.** The distortion is not an anonymity feature and not a
  fallback path; failure handling still hides the whole output rather than
  passing the raw feed through.

## Reproduction

```powershell
npm run typecheck
npm test
npm run build:packages   # only to regenerate the committed sample/negative fixtures
npm run check            # Scenario I (distortion flow) and Scenario G (motion)
npm run vcam:check
npm run validate:package -- fixtures/packages/face-distortion.zip
```

The check writes its screenshots, camera PNGs and `summary.json` under the
gitignored `evidence/check-<timestamp>/` directory.
