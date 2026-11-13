# Bounded secondary motion for packaged masks (issue #8)

This note records the schema-v3 secondary-motion contract, the fixed spring
simulation, the deliberate reset rules, the replay-based evidence and the
measured limits. It follows [note 0004](0004-effect-packages.md) (package
contract and import), [note 0005](0005-face-occlusion-and-anchoring.md)
(tracking, occlusion and pose smoothing) and
[note 0006](0006-face-distortion.md) (schema v2). All evidence here is from
recorded replay input and the Windows virtual camera on the development desktop;
no physical webcam or human participant was used, and no Blender or AI harness
runs during playback.

## What was built

### Contract: schema v3, additive and deliberately versioned

Schema version 3 adds one optional component to a mask package:

```json
"secondaryMotion": {
  "parts": [
    { "node": "ear-left",  "axis": "y", "drive": "yaw",   "stiffness": 60, "damping": 0.30, "maxAngleDeg": 32, "restAngleDeg": 0 },
    { "node": "ear-right", "axis": "y", "drive": "yaw",   "stiffness": 60, "damping": 0.30, "maxAngleDeg": 32, "restAngleDeg": 0 },
    { "node": "hair-tuft", "axis": "x", "drive": "pitch", "stiffness": 45, "damping": 0.25, "maxAngleDeg": 35, "restAngleDeg": 0 }
  ]
}
```

| Field | Required | Bound |
| --- | --- | --- |
| `parts` | yes | 1-4 entries |
| `node` | yes | an ASCII letter or digit first, then letters, digits, `_` or `-` (1-64 characters); exactly one node name in the mask GLB |
| `axis` | yes | `"x"`, `"y"` or `"z"` |
| `drive` | yes | `"yaw"`, `"pitch"` or `"roll"` |
| `stiffness` | yes | `4`-`400` (1/s²) |
| `damping` | yes | `0.05`-`1.5` |
| `maxAngleDeg` | yes | `1`-`60` |
| `restAngleDeg` | no (default `0`) | within `maxAngleDeg`, ±60 |

Each part is a **named GLB node**. The node's authored orientation is the
zero-offset base; the declared rest pose is that orientation plus
`restAngleDeg` (0 by default). The node origin is the pivot; the mask geometry
for that part is authored around it. The package supplies only bounded numbers
and node names, never geometry, shader code, a skeleton, a movement clip or
per-frame displacement.

**Why schema v3 rather than extending v2?** An older v2 build treats unknown
top-level fields as warnings. It would import a package that declares moving
parts, warn, and render a rigid mask — a silent behavior change. Bumping the
version makes an older build reject the package with
`schema-version-unsupported`, and this build rejects `secondaryMotion` in a v1 or
v2 manifest. Existing v1/v2 packages remain valid unchanged; a v3 manifest
without the component is also valid. `secondaryMotion` requires a mask, because
its parts are mask nodes; an import without one is rejected as
`secondary-motion-invalid`.

Every invalid declaration is rejected at import with the new stable code
`secondary-motion-invalid`, a field path and an actionable message (unknown or
duplicate node, node absent from or ambiguous in the GLB, unsupported
axis/drive, out-of-range parameters, rest offset beyond the bound, 0 or >4
parts, unknown field, missing mask). Validation inspects the GLB node names with
the same pure validator the app uses, so a typo cannot become an unanimated mask
at runtime.

### Runtime: a fixed spring driven by the accepted tracked pose

`src/core/secondary-motion.ts` is a pure, DOM-free simulator:

```
target = restAngleDeg + maxAngleDeg × clamp(headAngularVelocity[drive] / 45°/s, -1, 1)
angle  = clamp(angle, -maxAngleDeg, +maxAngleDeg)
```

- The **drive is the accepted tracked pose**, not wall-clock noise or a clip:
  angular velocity is the shortest-arc difference between consecutive accepted
  poses divided by their frame interval. The same pose the mask is attached to is
  used, including the bounded pose smoother's output.
- Each part integrates `x'' = ω_n²(target - x) - 2ζω_n x'` with `ω_n =
  sqrt(stiffness)` and `ζ = damping`. The target is proportional to head
  angular velocity, so a part lags while the head turns; when the head stops the
  target returns to rest and the underdamped spring keeps moving and settles.
- Integration splits each frame interval into equal sub-steps of **at most
  1/120 s** (`ceil(dt / (1/120 s))` sub-steps) with semi-implicit Euler. A given
  accepted-pose sequence therefore produces the same angles; this is not a fixed
  120 Hz accumulator and is not a claim of frame-rate independence.
  `performance.now()` is only used for the reported cost.
- `dt` is clamped to `[0.5, 250]` ms. The angle is hard-clamped to the declared
  bound and an outward velocity is zeroed at the clamp, so a saturating drive or
  spring overshoot cannot exceed `maxAngleDeg`.

`src/renderer/mask-renderer.ts` resolves the declared node names when the GLB is
parsed and applies `restQuaternion × axisAngle(angle)` to each node per frame.
A missing or ambiguous node fails the effect load, which uses the shared paused
output — it never falls back to the raw frame. `src/renderer/renderer.ts` owns
the simulator instance, the per-effect declaration key and the metrics.
The bundled procedural mask stays rigid; the issue's language is packaged masks,
so the demonstration and the movable-part contract are package-only. A future
bundled mask could reuse the same renderer hooks without a schema change.

### Deliberate resets (no impulse)

The spring state is dropped, and the part starts from the declared rest pose
(the authored GLB orientation plus `restAngleDeg`) with zero velocity, on:

| Trigger | Why |
| --- | --- |
| First accepted sample | No previous pose exists; start at rest. |
| Frame gap > 250 ms | A stale `dt` would integrate a huge, meaningless acceleration. |
| Pose discontinuity > 45° (or implied > 1080 °/s) | A seek, detector jump or reacquisition must not become a spring impulse. |
| Replay loop seam | The media time and pose intentionally jump at the seam; the caller resets before integrating that frame. |
| Tracking loss / reacquisition | The face may be at a different pose; recovery starts at rest and then follows the new pose. |
| Effect switch / explicit reset | A new declaration has its own rest pose. |

A held diagnostic frame keeps the last simulated angle: the hold resample does
not advance the spring, so the public A/B compares the same held pose instead of
resetting to rest because of the pause gap. This is a diagnostic-evidence
behavior, not a normal-playback shortcut.

### Diagnostics and published-output proof

The public **Secondary motion** diagnostic reports:

```
active=true parts=3 enabled=true updates=... resets=... lastReset=...
dtMs=... headSpeedDegPerSec=... maxAbsAngleDeg=... maxAngleDeg=32,32,35
angles=... names=ear-left,ear-right,hair-tuft axes=y:yaw,y:yaw,x:pitch
costMsLast=... costMsP95=... applied=simulated drawable=true
```

The diagnostic **Apply secondary motion (A/B)** toggle keeps the effect selected
and draws the declared rest pose. Exact 1280×720 PNGs captured through
the public **Capture evidence frame** control are compared: ON and OFF changed
1,864 pixels in the cited run, all on the packaged mask, two same-state captures
are pixel-identical, and the independent Media Foundation camera receives the
identical change. A dropped simulation makes ON == OFF; the OFF frame still comes
from the mask renderer, not the raw video element. This held-frame A/B isolates
the simulated angle; it is not a live-motion capture.

With the replay held, the diagnostic **Settle held frame** control advances the
same simulator with the stationary accepted pose. This is the strict post-turn
settling evidence: the retained angle decays toward rest under the same bounded
spring, with no synthetic reset or impulse, while the recorded frame stays fixed
so the decay is not confounded by the person continuing to move. It is a
diagnostic evidence path; normal playback runs the simulator only from presented
tracked frames.

## Evidence (replay-based, this development desktop)

Covered by `npm test` and `npm run check` scenario J:

- Unit tests (`tests/secondary-motion.test.ts`,
  `tests/effect-package.test.ts`, `tests/validation-coverage.test.ts`,
  `tests/effects.test.ts`): the committed schema v3 sample validates; v1/v2
  packages still validate; v2 + `secondaryMotion` and v1 + `faceDistortion` are
  rejected; every invalid motion declaration is rejected as
  `secondary-motion-invalid`; a mask without the component is valid; the
  simulator stays inside each bound under a saturating drive; a turn followed by
  a stop continues moving and settles; a gap, pose discontinuity,
  loop-seam/reacquisition reset and non-finite sample reset to rest with no NaN
  or impulse; yaw drives only yaw parts and pitch only pitch parts; rest offsets
  are honored; the same sample sequence is deterministic; radians conversion is
  correct.
- Scenario J (recorded `pose-loop-v1` clip, isolated package store) imports
  `reactive-ears.zip` through **Import package…**, selects it automatically,
  verifies preview and independent camera PNGs contain the package's exact unlit
  material, and samples the documented 8 s turn/nod/lean window: 17/18 frames
  tracked, per-part angle ranges 59.7°/59.7°/42.0° in the cited run, maximum
  observed 30.75° (all inside the declared 32/32/35° bounds). Three screenshots
  are saved. A camera-captured sequence runs during the same window: every
  app-published PNG must contain the package material, while the diagnostic
  samples over that interval report nonzero, bounded part angles. It does not
  isolate the part-pixel change from the moving video; the held A/B isolates
  the simulated angle.
- **Post-turn residual (live):** a separate documented window starts at 25.0 s
  for 1.9 s (the recorded head turn around 25.9 s is followed by about a second
  of low head angular velocity). In the cited run the live window measured a
  spring peak of 17.71°, still 7.90° after head angular speed fell to 8.5°/s, and
  a near-rest 2.73° 833 ms after the peak (15.4% of peak). The recorded person
  does not actually stop and keeps producing small head motion later, so this
  live window is a **residual/near-rest observation**, not a demonstration of a
  monotonic stop; the strict decay evidence is the held-frame settle below. A
  second camera-captured sequence spans the same window and must contain the
  package material in every app-published PNG.
- **Held-frame settling (strict):** after the A/B, the replay stays held at the
  documented 47.7 s post-turn frame and the diagnostic **Settle held frame**
  control advances the same simulator with the stationary accepted pose. In the
  cited run the retained 8.70° decayed to 0.03° (0.3% of the retained angle)
  over about 2.9 s, and the minimum after one second was 0.02°. This is the
  deterministic post-turn decay evidence; the head is stopped by the hold, so
  the spring's continued motion and settling are unambiguous.
- **Loop boundary:** crossing a loop seam increased the reported reset count
  (3 → 4) and the seam frame's angles were near rest
  (-0.28°/-0.28°/1.18° in the cited run, all within 1.2° of the declared 0°
  rest); the angles stayed bounded.
- **Reacquisition:** tracking loss paused the output in preview and camera,
  reset the spring (angles exactly rest), and recovery resumed from rest; the
  reported recovery sample was 5.02°/5.02°/10.11° (maximum 10.11°, bounded and
  driven by the new pose).
- **Published-output A/B:** on the held 47.7 s post-turn frame the retained
  angle was 8.70°; simulated vs rest changed 1,864 pixels, all inside the mask
  rectangle, with 0 same-state self-diff for ON and OFF. The independent camera
  PNG changed by the identical 1,864 pixels. The retained held angle varies with
  the exact held frame (8–24° across recent runs); the assertion requires at
  least 5° and at least 800 changed pixels.
- **Paused-output policy:** manual pause, injected tracking loss, injected
  multiple faces, simulated processing failure, an async package switch and
  explicit `No effect` all hide the output. Manual pause, tracking loss and
  processing failure were camera-captured (opaque paused canvas ≈ 12,15,20).
  Removal of the active package falls back to the opaque no-effect output and
  leaves other packages installed.
- **Negative fixtures:** `secondary-motion-schema-v2` is rejected as
  `schema-version-unsupported`; the invalid axis, unknown node, out-of-range
  stiffness, unknown field, rest-beyond-max and missing-mask fixtures are
  rejected as `secondary-motion-invalid`, keep the current effect rendering, and
  cause no renderer console error.
- **Replay-based workload:** the pure spring update measured about 0.1 ms p95
  (timer granularity, main thread only); the full render p95 was 5.8 ms with the
  simulated pose versus 5.8 ms with the declared rest pose, and the presented
  frame interval p95 was 44.3 ms versus 44.3 ms in two sequential 2.2 s windows.
  The OFF state still runs the simulation but draws rest, so these deltas are
  observed run variation, not an isolated simulation cost.

The cited run is `evidence/check-2026-11-13T22-22-14-119Z/summary.json` at code
head `7a087d7ddaacf900657ba71a84f037dd4ebb2dd6` (94/94 checks). A later fix
round adds the camera sequences and the media-time residual gate without
changing the fixture's observable simulation behavior; values vary run to run
under desktop load.

## Supported parameters for the later AI creator skill

The creator-facing contract is in
[`docs/effect-packages.md`](../effect-packages.md#secondarymotion-schema-v3).
In short: give each movable part its own named GLB node with the pivot at the
node origin, then declare up to four parts with `node`, `axis`, `drive`,
`stiffness` (4-400), `damping` (0.05-1.5), `maxAngleDeg` (1-60) and optional
`restAngleDeg` (within `maxAngleDeg`). The runtime maps head angular velocity at
45°/s to the full angle bound. Do not export a Blender physics simulation and
expect it to play; express the intent as these bounded parts. Run
`npm run validate:package -- <zip>` before import.

## Limitations

- **Rigid-spring model only.** Each part is one rigid node rotating about one
  local axis. There is no strand-level hair, cloth or soft-body simulation, no
  chained bones, no collision with the face or itself, and no arbitrary Blender
  physics conversion. This is the explicit prototype scope.
- **Drive mapping is fixed.** The runtime maps a single head-rotation component
  to one part at a fixed 45°/s full scale. A package cannot change the gain law,
  the damping law, gravity, wind or a per-part phase.
- **Recorded coverage.** Motion is evidenced on `pose-loop-v1` (turns/nods/lean
  and the documented post-turn window). Faster or more extreme head motion is
  handled by the same bounds and discontinuity resets but is not separately
  evidenced.
- **Replay only.** No physical-camera or live-human evidence exists in this
  slice. The camera sequences are replay-driven and show the packaged mask in
  app-published frames during motion; they do not isolate the movable-part pixels
  from the moving video, and the held A/B is not a live-motion capture.
  Physical-camera behavior, camera-sensor latency and call-application
  compatibility remain for final live acceptance.
- **Desktop only.** Measured on the RTX 3070 Ti development desktop; laptop
  integrated-graphics behavior is unverified.
- **Not a benchmark.** The timing numbers are replay-derived main-thread
  observations at this head, not the 720p/30 FPS / ≤100 ms target and not an
  isolated simulation cost.
- **Policy unchanged.** A disappearing node, effect-load failure or any tracking
  failure hides the whole output behind the opaque paused screen in preview and
  camera; there is no raw fallback.

## Reproduction

```powershell
npm run typecheck
npm test
npm run build:packages   # only to regenerate the committed sample/negative fixtures
npm run check            # Scenario J (secondary motion) plus the existing scenarios
npm run vcam:check
npm run validate:package -- fixtures/packages/reactive-ears.zip
```

The check writes the A/B PNGs, motion screenshots, camera PNGs and
`summary.json` under the gitignored `evidence/check-<timestamp>/` directory.
