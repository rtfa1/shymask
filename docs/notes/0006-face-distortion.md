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

### Diagnostics

The public **Face distortion** diagnostic reports:

```
active=true mode=bulge strength=0.6 radiusScale=1.35 centerOffset=0,0
faceX=... faceY=... faceW=... faceH=...
centerX=... centerY=... radiusX=... radiusY=...
costMsLast=... costMsP95=...
warpDelta=... changedInsidePct=... changedOutsidePct=...
```

`warpDelta`, `changedInsidePct` and `changedOutsidePct` come from a 64×36
comparison between the source frame and the distorted frame of the **same**
presented frame, split by the same ellipse. They prove the pipeline really
changed output pixels and that the change is localized to the tracked face
region; they are a diagnostic, not a per-pixel quality metric.

## Evidence (replay-based, this development desktop)

Covered by `npm test` and `npm run check`:

- Unit coverage (`tests/face-distortion.test.ts`,
  `tests/effect-package.test.ts`, `tests/effects.test.ts`,
  `tests/output-policy.test.ts`, `tests/validation-coverage.test.ts`): the
  committed schema v2 sample validates; v1 packages still validate; v1 +
  `faceDistortion` is rejected; invalid mode/strength/radius/offset/unknown
  field are rejected as `distortion-invalid`; optional fields default; the warp
  ellipse follows the face box translation and scale, respects `centerOffset`,
  and reverses for pinch; the pure mapping clamps out-of-bounds input.
- Scenario I (default recorded clip) imports `face-distortion.zip` through the
  public **Import package…** control, selects it automatically, asserts the
  active distortion diagnostic and its face-following ellipse, captures a
  processed preview PNG plus an independent Media Foundation camera PNG, and
  exercises every paused-output case (manual pause, tracking loss, multiple
  faces, processing failure, switching, no-effect and removal) in preview and
  camera. It also rejects the four distortion negative fixtures with their
  documented codes and keeps the previous effect rendering.
- Scenario G (recorded `pose-loop-v1` clip, documented 8 s turn/nod/lean
  window): the warp ellipse's centre follows the tracked face box and moves at
  least 30 px across the window; each sampled frame passes the inside/outside
  pixel-change gates; three screenshots are saved. This is the motion evidence
  for the face-following requirement.
- Timing (default clip, replay-derived): the offscreen warp pass, the full
  render/composite cost and the presented-frame interval are recorded while the
  distortion is active, with a color-only package on the same fixture as the
  baseline. These are observations for the later complete-effect benchmark
  (#10/#11), not a performance target.

### Measured values (replay-based, this run)

Hardware and source are the same development desktop and fixtures as note 0005
(i7-11700K, RTX 3070 Ti, 31.8 GiB, Windows 11 Pro 26100; MediaPipe Face
Landmarker 0.10.21 GPU delegate; Three.js 0.180.0). The distortion sample is the
415-byte `fixtures/packages/face-distortion.zip` (1 entry, 496-byte schema v2
manifest, no mask asset). The public check's run recorded:

| Measurement | Value |
| --- | --- |
| Default-clip warp change | about 70% of inside-ellipse samples changed, about 0.2% outside, warp delta about 1.4 (0-255 mean absolute) |
| Distortion preview PNG | exact 1280×720 captured output, non-paused (mean RGB about 139,51,43 on the run's frame) |
| Distortion camera PNG | independent Media Foundation consumer mean matched the preview within the check's tolerance |
| Offscreen warp pass, p95 | 0.4 ms at 1280×720 (rolling p95 after warm-up) |
| Render + composite + diagnostics, p95 | 14.9 ms vs 13.9 ms for the color-only baseline (observed delta about 1.0 ms) |
| Presented-frame interval, p95 | 65.2 ms vs 48.8 ms in the sequential comparison; this difference is larger than the 0.4 ms warp cost and the two 2.2 s windows are not isolated, so it is reported as observed run variation, not attributed added cost |
| Recorded-motion window | 18/18 samples tracked on `pose-loop-v1`; warp centre moved about 91×80 px with the face box; inside-ellipse change about 60% (every sample passes the ≥8% inside / ≤3% outside gates) |
| Paused-output camera captures | manual pause, tracking loss, multiple faces, processing failure, no-effect and removal all delivered the opaque paused canvas (mean ≈ 12,15,20) |

The measured inside/outside split is what distinguishes a face-following warp
from a static overlay: outside the ellipse the shader is an identity pass, so
the same-frame comparison changes 0.2% of outside samples (resampling noise) but
69.6% inside. The pixel-change metric is diagnostic evidence, not a visual
quality score; the saved PNGs show the resulting frames.

See the measured values in the run's `summary.json`
(`effectPackages.faceDistortion`, `effectPackages.evidence.distortion` and
`tracking.evidence.recordedMotion.distortion`) and
`evidence/logs/check-final.log`.

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
  recorded clip with a virtual camera. They do not establish the parent
  spec's 720p/30 FPS / ≤100 ms target, and they exclude a target call/stream
  application.
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
