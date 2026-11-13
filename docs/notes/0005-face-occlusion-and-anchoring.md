# Face occlusion and bounded face anchoring (issue #6)

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
- the gain is normalized to the presented frame interval (`1000/24 ms`), so the
  effective per-sample alpha at the observed ~35 ms interval is about 0.34 rather
  than the 0.45 base gain; a long gap (>250 ms), the first sample, or leaving the
  `tracking` phase snaps instead of smoothing from stale state;
- hard caps move the filter toward the raw pose if the measured offset would
  exceed **4 cm** translation or **8 deg** rotation. The normal adaptive gain
  stays far below these caps; they make the lag bound independent of the
  recorded motion;
- the constant-velocity lag of the base gain at the 24 Hz **reference interval**
  is `(1 - 0.45) / 0.45 × reference frame interval ≈ 51 ms`; this is a
  reference-interval figure, not a global maximum. At the observed p95 frame
  interval of ~35 ms the implied delay p95 was **~61 ms**, and the filter itself
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

The evidence captures are not single-shot. A processed camera state is captured
with up to three bounded attempts of eight consumer frames each, because a new
Media Foundation consumer starts with an empty native frame cache and can see
the opaque fallback until the app publishes to its client; `holdRenderedFrameAt`
also retries up to three times if a hold lands on a transient pause, and the hold
helper waits 1 s before capture. The attempt count and the app-published vs
native-fallback frame count of every attempt are written to `summary.json`
(`virtualCamera.captureAttempts`) and the check log, and the final attempt still
fails on a persistent fallback. Before each processed capture, the expected
preview mean is read only once the public status reports `render` and the
throttled mean-RGB diagnostic has caught up, so a camera frame is never compared
against the previous paused mean after an effect switch.

## Measured behavior (replay-based)

Hardware and source are the same development desktop and fixtures as note 0003
(i7-11700K, RTX 3070 Ti, 31.8 GiB, Windows 11 Pro 26100; MediaPipe Face Landmarker
0.10.21 GPU delegate; Three.js 0.180.0). The recorded clip is `pose-loop-v1`.
Measurements below are observations, not performance-target claims.

### Occlusion A/B on two side-view frames (yaw about −20° to −22° and +9° to +14°)

The primary held frame is 47.7 s (yaw about −20° to −22° across runs). A second
held frame at 16.0 s has yaw in the opposite direction (about +9° to +14° at the
frozen frame), so the A/B covers both turn directions. Both ON and OFF were
captured twice through the public control; each pair of same-state PNGs was
pixel-identical (self-diff 0). Disabling only the occluder changed these many
pixels, required to be at least 88% inside the tracked face's **axis-aligned
bounding box** and at least 1,500 px inside it:

| Mask | Changed pixels | Inside tracked face bbox | Notes |
| --- | --- | --- | --- |
| Bundled procedural helmet | 15,705–16,146 | 88.8–91.0% | preview and independent camera PNGs matched; ON and OFF self-diff 0 |
| `guard-visor` package (mask + treatment) | 5,319–5,441 | 94.5–96.5% | imported through **Import package…**; camera A/B too |
| `rose-visor` package (mask only, nonzero attachment) | 2,257–2,306 | 100.0% | imported through **Import package…** |

The table is the primary 47.7 s frame. The second angle applies the same gates and
across runs recorded 17,250–17,414 changed bundled pixels (91.0–93.8% inside the
bounding box) and 5,510–5,700 changed `guard-visor` pixels. The facing view and
the turned views are deliberately different: the turned frames show the canonical
face region cutting into the helmet shell where mask geometry would otherwise
draw through the forehead/cheek. The bounding box is a rectangular proxy for the
face region, not a hand-drawn silhouette and not the hairline. See the evidence
PNGs `28-*-occlusion-on.png` / `28-*-occlusion-off.png` and
`28b-*-occlusion-on.png` / `28b-*-occlusion-off.png` in the check run directory.

Each A/B also proves positively that the ON state reveals non-mask content where
the OFF state drew mask material. For the imported packages the exact unlit
material colour covers at least 99% of the changed face-box pixels in OFF and at
most 1.5% of the same pixels in ON (enforced ≥97% / ≤3%). The bundled procedural
mask uses lit materials, so the check takes the dominant exact OFF-frame mask
colours from the changed region (top 64 shades, at least 90% coverage) and
requires that none of them reappear in ON at those pixels (at most 1%; observed
0). Removing the mask colour is not by itself proof that the reveal is video: a
black, transparent or uniform fill would also remove it. The ON changed pixels
must therefore also pass a plausible-video floor — mean luminance ≥30, luminance
standard deviation ≥6, at most 10% near-black pixels and at least 16 distinct
colours — and for the untreated bundled mask and `rose-visor` at least 90% of the
sampled ON pixels must match the underlying held replay frame drawn at the
pipeline's 0,0,1280,720 scale. Observed ON pixels had mean luminance 128–140 and
luminance standard deviation 33–34 (floors 30 and 6), with a held-replay match of
0.94–0.97 for the bundled and `rose-visor` masks (floor 0.90). The check therefore
proves that mask material is removed and plausible video is revealed; the saved
PNGs show the face. It is not an exact-colour proof of identity, and for a treated
package the treatment rules out a pixel-for-pixel comparison with the raw replay.

The independent Media Foundation consumer received exactly the same change (same
total and same inside-bbox pixel count) from the same held frame for the bundled
mask and `guard-visor`; that equality is asserted, not just recorded. There is no
`rose-visor` camera A/B.

Because face occlusion can legitimately hide the packaged mask's
bounding-box-centre probe, the preview probe is asserted only when the public
diagnostic reports it visible, and the camera probe is asserted under the same
condition. The assertion reads the actual saved ON PNG pixel at the diagnostic
coordinates; the diagnostic value itself is metadata and is no longer compared
with itself. Composition is proved independently by counting the package's exact
unlit material colour in exact 1280×720 preview and camera PNGs (enforced
>20,000 for guard and >25,000 for rose; observed about 31,000–33,000 and
38,000–40,000 across recent runs, 40,025 at the reviewed head run).

The separate motion-window camera capture is taken on the same held 47.7 s frame
as the bundled occlusion A/B, not on live playback. The moving behavior is
evidenced by the sampled window and the three saved motion screenshots; the held
frame keeps the camera evidence stable and reproducible. In the automated
Electron/Playwright session, resuming live playback after the long held A/B and
crossing a loop seam occasionally stopped the video frame-callback timestamps
(the output then correctly entered the paused policy), so the camera check
deliberately does not depend on that resume. This is a diagnostic-path
limitation, not evidence about physical-camera or live-playback behavior.

### Jitter and added lag (recorded turns/nods/leaning)

The initial segment of the documented 41.6 s window is a slow segment, not a
stationary one. The check measures it rather than assuming it: over the ~2 s
segment the mask pose spanned about 5.8–8.5° yaw, 5–9° pitch and ~2° roll with
11–14 px origin movement, and the filter p50 gain stayed at ~0.33–0.34 (near the
base gain at the observed frame interval). The bounds enforced for calling it a
slow jitter segment are 10° yaw, 10° pitch, 5° roll, 30 px origin and p50
alpha ≤ 0.4. Raw and smoothed poses were measured over the same frames.

| Measurement | Raw | Smoothed |
| --- | --- | --- |
| Slow-segment origin jitter, p95 second difference | 3.7–4.2 px | 1.5–2.3 px |
| Slow-segment rotation jitter, p95 second difference | 2.4–2.6 deg | 1.0–1.4 deg |
| Slow-segment origin jitter reduction | — | 40–66% (gate ≤0.80× raw) |
| Slow-segment rotation jitter reduction | — | 43–58% (gate ≤0.85× raw) |

Recent runs measured smoothed origin 1.72–2.23 px (41.6–55.3% lower) and
smoothed rotation 1.09–1.36 deg (43.8–57.9% lower), and the ranges above cover
all of them.

Across the full motion window, the adaptive gain prioritizes responsiveness.
The measured added offset was p95 **3.6–4.3 px** origin and **1.7–1.9 deg**
rotation, with an implied constant-velocity delay p95 of **60.2–61.6 ms** and a
filter cost p95 of **0.1 ms**. The 8 s window tracked 17–18 of 18 sampled frames
and produced yaw 26–30°, pitch 22–36°, roll 12–19° and 94–100 × 44–77 px
mask-origin movement. The mask origin stayed inside the tracked face
bounding box expanded by 35% of its width/height at every sample.

Sliding is quantified over the same motion window: the p95 deviation of the
rendered (smoothed) projected mask origin from its median offset to the tracked
face-box centre was about **12–20 px** (about 5–9% of face width). That is a
bounded measured claim — p95 sliding stays under the self-chosen 24 px bound — not
a claim that the mask does not slide. The check samples the same documented
window a second time through the public **Pose smoothing** raw mode (the shadow
smoother still runs), so the raw-mode p95 is measured over comparable recorded
motion; the check reports it without asserting it, because only the rendered
output is the user-visible path. Observed runs measured **raw-mode 8.6–11.5 px**
and rendered 12.5–18 px, so smoothing did **not** reduce this proxy metric (the
rendered pass was about 9–77% higher across runs, consistent with filter lag and
with frame-timing differences between the two passes); the smoother's measured
benefit is the slow-segment jitter reduction above, not sliding. The face-box
centre itself shifts under yaw, so this is a proxy metric, not a ground-truth
surface distance, and no correction is claimed. The raw origin-to-face-centre
offset p95 in the rendered pass was about **30–34 px** (enforced bound 60 px). The
clipping metric is the mask pixels removed inside the face bounding box by the
occluder in each A/B (at least 1,500 px; observed 2.3k–17.3k depending on mask and
angle).

## Supported motion limits and remaining limitations

- **Recorded coverage:** the pinned motion window contains turns/nods/leaning up
  to about 29° yaw, 31° pitch and 19° roll at this framing, and the occlusion A/B
  adds a held side view in the opposite yaw direction (about +9° to +14°). Faster, more
  extreme or intermediate poses are handled by the adaptive gain and hard caps
  but are not evidenced by this clip.
- **Replay only:** no physical-camera or live-human evidence exists in this
  slice. Camera-sensor, call-network and real Zoom/Meet/OBS behavior remain for
  final live acceptance.
- **Automated diagnostic path:** the motion-window camera capture uses the held
  47.7 s frame, and a long held A/B followed by live resume plus a loop seam
  occasionally stops the video frame-callback timestamps in the automated
  session (the output correctly hides under the paused policy). The check
  therefore does not use that resume for evidence; normal continuous looping is
  still exercised elsewhere in `npm run check`.
- **Desktop only:** measured on the RTX 3070 Ti development desktop; laptop
  integrated-graphics behavior is unverified.
- **Rigid neutral face:** the occluder is the canonical neutral surface, so a
  large expression (for example a wide open mouth) is not reconstructed; the
  mask is rigid as well. Hand-over-mask occlusion is explicitly out of scope, as
  is secondary motion (issue #8) and distortion (issue #7).
- **Face surface only:** the occluder has no hair, ears, neck or full head
  silhouette. Mask geometry that passes through those regions, or through the
  head outline outside the canonical face surface, is not hidden by this
  occluder. The A/B evidence covers the face region as a bounding-box proxy, not
  a hand-drawn head mask.
- **Residual visual artifacts:** the check quantifies clipping removal (the mask
  pixels removed inside the tracked face bounding box) at two recorded side
  views in opposite yaw directions; it does not prove clean occlusion at poses
  outside the recorded coverage and does not assert occlusion continuously while
  the person moves through the motion window. At such extreme poses the rigid
  mask can still partially intersect the face surface or leave a thin visible
  edge, and the occluder hides depth-behind-face fragments rather than every
  possible authoring mistake in a mask.
- **No prediction:** smoothing is a filter, not motion prediction. The measured
  60.2–61.6 ms implied delay plus tracker/render cost is below the 100 ms
  processing budget on this desktop, but the budget is not a final live claim.
  The ~50.9 ms reference-interval figure reported alongside the filter is not a
  global maximum; the effective alpha at the observed ~35 ms frame interval is
  about 0.34.
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

The public check writes the A/B PNGs, the ON/OFF repeat PNGs and `summary.json`
under `evidence/check-<timestamp>/`; `summary.json` also records every processed
camera capture attempt and its app-published/native-fallback frame counts, so the
bounded retries are visible rather than implied. `docs/notes/0003` still records
the tracker thresholds and the paused-output matrix.
