# Face occlusion and bounded mask anchoring (issue #6)

This note records the face-occlusion method, the bounded pose smoother, the
measured replay-based behavior on recorded turns/nods/leaning, and the remaining
limits. It extends [note 0003](0003-face-tracking-and-mask.md), which covers the
tracker, the rigid mask and the paused-output policy. All evidence here is from
recorded replay input and the Windows virtual camera on the development desktop;
no physical webcam or human participant was used.

## What was built

### Face-based occlusion

The mask scene now contains a **depth-only copy of the canonical face surface**
in addition to the mask content. It is rendered first in the same group as the
mask, with the same tracked facial transformation matrix, using:

- the 468-vertex / 898-triangle MediaPipe `face_geometry` canonical face model,
  committed as [`src/renderer/canonical-face.ts`](../../src/renderer/canonical-face.ts)
  and regenerated with `npm run build:face-occluder`;
- `MeshBasicMaterial` with `colorWrite: false`, `depthWrite: true`,
  `depthTest: true` and `DoubleSide`;
- `renderOrder = -1`, so its depth is in the buffer before mask fragments are
  tested.

The face writes depth but no colour. Mask fragments behind the reconstructed
face fail the depth test, so the real face (the video underneath the transparent
mask canvas) shows through. No screen-space face-shape heuristic is used, and
the occluder is not authored per effect: because bundled procedural content and
imported package GLBs both render under the same mask group, the same occluder
applies to both.

**Why the canonical mesh and the tracked matrix, not per-frame landmark
triangles?** MediaPipe's facial transformation matrix is the fit of this exact
canonical model. Rendering the same model with that matrix reconstructs the face
surface consistently with the mask attachment, is pose-correct for turns, nods
and leans, adds no second inference or per-frame GPU buffer upload, and has a
stable silhouette. Reconstructing a triangle mesh from per-frame landmark
positions would need an extra unprojection/scale assumption, would carry the
landmark noise into the occluder edge, and would not reliably align with the
mask's canonical space. The trade-off is that the occluder is the neutral
canonical surface: it does not deform with a smile or an open mouth. The mask is
rigid too, so this is a deliberate rigid-face approximation, recorded as a
limitation below.

### Bounded pose smoothing

`src/core/pose-smoothing.ts` adds an exponential smoother for the accepted
tracker matrix:

- translation is filtered component-wise; rotation is filtered as a quaternion
  with shortest-arc slerp, so a turn through the quaternion sign boundary does
  not spin the mask;
- the per-sample gain is `baseAlpha = 0.45` at rest and rises linearly to `1` as
  measured face speed approaches **360 deg/s** or **60 cm/s**. Slow tracking
  noise is therefore damped, while a real fast turn/nod is passed through;
- the gain is normalized to the presented frame interval (`1000/24 ms`), and a
  long gap (>250 ms), the first sample, or leaving the `tracking` phase snaps
  instead of smoothing from stale state;
- hard caps move the filter toward the raw pose if the measured offset would
  exceed **4 cm** translation or **8 deg** rotation. The normal adaptive gain
  stays far below these caps; they make the lag bound independent of the
  recorded motion;
- the constant-velocity lag is bounded by
  `(1 - 0.45) / 0.45 × frame interval ≈ 51 ms` at 24 Hz. At the observed p95
  frame interval of ~35 ms the implied delay p95 was ~61 ms; the filter itself
  costs ~0.1 ms p95.

The smoother is applied only to matrices the tracking state machine accepted as
reliable. The pose-jump guard still evaluates the raw matrix, so one detector
glitch cannot be smoothed into a published mask frame. Leaving `tracking` resets
the smoother, so reacquisition snaps to the new face instead of trailing the
pre-loss pose.

The diagnostic **Pose smoothing** control renders the raw tracker pose for A/B
comparison while the same smoother still runs as a shadow filter. Both raw and
smoothed jitter are therefore measured over exactly the same presented frames.

### Repeatable visual evidence

The diagnostic **Hold replay frame** control pauses the replay and re-samples
the held image once, so the mask pose and frozen video frame agree. The public
**Capture evidence frame** control then writes exact 1280×720 PNGs for an
occlusion on/off A/B. The decode watchdog is told not to expect frames while the
control is on; this holds the last valid replay frame and is not a passthrough or
a paused-output bypass.

## Measured behavior (replay-based)

Hardware and source are the same development desktop and fixtures as note 0003
(i7-11700K, RTX 3070 Ti, 31.8 GiB, Windows 11 Pro 26100; MediaPipe Face Landmarker
0.10.21 GPU delegate; Three.js 0.180.0). The recorded clip is `pose-loop-v1`.
Measurements below are observations, not performance-target claims.

### Occlusion A/B, 47.7 s side-view frame (yaw about −21°)

Each state was captured twice through the public control; the two same-state
PNGs were pixel-identical (self-diff 0). Disabling only the occluder changed
these many pixels, almost all on the tracked face:

| Mask | Changed pixels | Inside tracked face | Notes |
| --- | --- | --- | --- |
| Bundled procedural helmet | 15,705–16,146 | 89.4–91.0% | preview and independent camera PNGs matched; 0 self-diff |
| `guard-visor` package (mask + treatment) | 5,319–5,441 | 94.9–96.0% | imported through **Import package…** |
| `rose-visor` package (mask only, nonzero attachment) | 2,257–2,306 | 100.0% | imported through **Import package…** |

The facing view and the turned view are deliberately different: the turned view
shows the face/hair silhouette cutting into the helmet shell where the mask
geometry would otherwise draw through the forehead/cheek. See the evidence PNGs
`28-*-occlusion-on.png` / `28-*-occlusion-off.png` in the check run directory.
The independent Media Foundation consumer received the identical occlusion
change (same pixel count and inside-face fraction) from the same held frame.

Because face occlusion can legitimately hide the packaged mask's
bounding-box-centre probe, the package scenario now proves composition by
counting the package's exact unlit material colour in exact 1280×720 preview and
camera PNGs (guard: >31,000 pixels; rose: >38,000). The probe pixel is still
asserted whenever it is visible, and the probe colour metadata is always checked.

### Jitter and added lag (recorded turns/nods/leaning)

The low-motion part of the documented 41.6 s window (about 1.5–2 s) is where
tracking noise dominates; the full 8 s window covers turns, nods and leaning.
Raw and smoothed poses were measured over the same frames.

| Measurement | Raw | Smoothed |
| --- | --- | --- |
| Low-motion origin jitter, p95 second difference | 3.7–4.3 px | 1.4–2.1 px |
| Low-motion rotation jitter, p95 second difference | 2.4–2.6 deg | 1.1–1.4 deg |
| Low-motion origin jitter reduction | — | 44–66% |
| Low-motion rotation jitter reduction | — | 44–56% |

Across the full motion window, the adaptive gain prioritizes responsiveness.
The measured added offset was p95 **3.6–4.2 px** origin and **1.7–1.9 deg**
rotation, with an implied constant-velocity delay p95 of **60.6–61.3 ms** and a
filter cost p95 of **0.1 ms**. The 8 s window tracked 17–18 of 18 sampled frames
and produced yaw 26.4–28.8°, pitch 24.9–29.7°, roll 13.3–18.0° and 95–98 ×
48–77 px mask-origin movement, with the mask inside the tracked face at every
sample.

## Supported motion limits and remaining limitations

- **Recorded coverage:** the pinned motion window contains turns/nods/leaning up
  to about 29° yaw, 29° pitch and 18° roll at this framing. Faster or more
  extreme motion is handled by the adaptive gain and hard caps but is not
  evidenced by this clip.
- **Replay only:** no physical-camera or live-human evidence exists in this
  slice. Camera-sensor, call-network and real Zoom/Meet/OBS behavior remain for
  final live acceptance.
- **Desktop only:** measured on the RTX 3070 Ti development desktop; laptop
  integrated-graphics behavior is unverified.
- **Rigid neutral face:** the occluder is the canonical neutral surface, so a
  large expression (for example a wide open mouth) is not reconstructed; the
  mask is rigid as well. Hand-over-mask occlusion is explicitly out of scope, as
  is secondary motion (issue #8) and distortion (issue #7).
- **Residual visual artifacts:** at extreme poses the rigid mask can still
  partially intersect the face silhouette or leave a thin visible edge; the
  occluder hides depth-behind-face fragments, not every possible authoring
  mistake in a mask.
- **No prediction:** smoothing is a filter, not motion prediction. The measured
  60.8–61.3 ms implied delay plus tracker/render cost is below the 100 ms
  processing budget on this desktop, but the budget is not a final live claim.
- **Policy unchanged:** tracking loss, unreliable tracking, multiple faces,
  manual pause, switching, startup and processing failures still replace the
  entire output with the opaque paused screen in preview and camera. The
  smoother and occluder are not a fallback path; they only shape processed
  frames.

## Provenance

The canonical face geometry is MediaPipe's
`mediapipe/modules/face_geometry/data/canonical_face_model.obj`
(Apache-2.0, Google LLC), pinned in
[`scripts/build-face-occluder.mjs`](../../scripts/build-face-occluder.mjs) by
source URL and SHA-256
`8bac80443397e113f41a8b565ea72c59390bc031d9defab289dba7bc0c54e618`. The app
build/run/tests do not fetch it; only the explicit regeneration command does.

## Reproduction

```powershell
npm run typecheck
npm test
npm run check   # Scenario G: recorded motion, smoothing timing, occlusion A/B + camera A/B
npm run vcam:check
npm run build:face-occluder  # only to regenerate the committed canonical table
```

The public check writes the A/B PNGs and `summary.json` under
`evidence/check-<timestamp>/`; `docs/notes/0003` still records the tracker
thresholds and the paused-output matrix.
