# Shymask

Shymask applies visual effects to a webcam feed and publishes the result as a virtual webcam. This
repository currently delivers a **recorded-replay preview** (issue #2), the **Windows 11 virtual
camera** (issue #3), **one-face tracking with a basic rigid 3D mask** (issue #4), **imported,
validated effect packages** (issue #5), **face-based occlusion with bounded face anchoring**
(issue #6), and a **packaged face-distortion effect** (issue #7): a desktop
preview loops a recorded webcam-style clip at real-time pacing, tracks exactly one face, attaches a
procedural low-poly mask to that face, hides mask geometry behind the face, applies bounded
declarative color treatments and an optional bounded face-following distortion, displays a selectable
effect, and publishes its 1280×720 output canvas as **Shymask Camera** so other applications can
select it. The camera publishes the app's output canvas; a native opaque paused fallback covers the
short window before the app connects and is used when app frames stop arriving. No physical webcam,
account, cloud service, or live test subject is used.

An effect package is a ZIP containing a versioned `manifest.json` plus declared assets only —
never executable effect code. A package is **one complete effect** that may combine a rigid GLB
mask and/or a declarative color treatment (schema v1) with an optional bounded face distortion
(schema v2). Imported effects use the same tracking, rendering and camera path as the bundled mask.
The versioned contract, limits, error codes and authoring guidance are in
[`docs/effect-packages.md`](docs/effect-packages.md); the distortion design and evidence are in
[`docs/notes/0006-face-distortion.md`](docs/notes/0006-face-distortion.md).

Tracking readiness and loss gate every effect: zero faces, multiple faces, unreliable tracking, a
missing tracker model, no effect, manual pause and processing failures all replace the whole output
with the exact opaque "Tracking paused" screen in both the preview and the virtual camera. There is
no raw-passthrough branch.

Secondary motion, real call-application compatibility (issue #10), the Blender/AI authoring flow
(issue #9), complexity budgets (issue #11), and the final 720p/30 FPS / 100 ms target are later child
tickets of the parent spec. Hand-over-mask occlusion remains out of scope.
## Quick start (Windows 11)

Prerequisites: Node.js 22.12+ (tested with 24.19.0) and npm 11+. The Windows virtual camera also
needs the MSVC "Desktop development with C++" workload and the Windows 11 SDK
(`mfvirtualcamera.h`, `mfsensorgroup.lib`), plus a one-time elevated install step. No Python,
ffmpeg, or .NET SDK is required. Network access is needed for `npm install` and the one-time fixture
and model downloads.

```powershell
npm install
npm run fetch:fixture   # downloads ~2.7 MB to fixtures/cache and verifies SHA-256
npm run fetch:tracker   # downloads the ~3.6 MB pinned Face Landmarker model and verifies SHA-256
npm run build:native    # ShymaskVirtualCamera.dll, shymask-vcam-host.exe, shymask-camera-consumer.exe

# First time only, from an elevated PowerShell prompt:
npm run vcam:install    # stages binaries + machine-wide (HKLM) camera registration

npm start               # builds and opens the desktop preview window
```

The window starts on the opaque "Tracking paused" output. **Start** stays disabled until the fixture
and the face tracker (WASM runtime + verified model) are ready. Press **Start** to begin the replay;
the first detection establishes tracking and the selected effect appears. The **Virtual camera** panel
shows whether `Shymask Camera` is registered; camera consumers receive the same frames as the
preview. If the camera is not installed, the preview still works and the panel explains the one-time
elevated install.

If `npm install` blocks install scripts (newer npm releases gate them), run
`npm approve-scripts esbuild` and re-run `npm install`.

## Controls

| Control | Behavior |
| --- | --- |
| **Start** | Begins real-time playback of the fixture already validated at launch. Disabled while the fixture is missing or corrupt, the face tracker is unavailable, playback has already started, or manual pause is active. |
| **Pause / Resume** | Manual pause replaces the whole output with the opaque "Tracking paused" screen and freezes processing. It persists until Resume is pressed, including across automatic tracking recovery. |
| **Effect** | One complete effect at a time: `Rigid mask`, `Warm tint`, `Cool tint`, `Monochrome`, explicit `No effect`, or any imported package. Bundled options are followed by an **Imported packages** group. A package may combine its own mask, bounded face distortion and color treatment; components from different packages are never stacked. Choosing `No effect` hides the output; choosing an effect restores it automatically once one face is tracked. Tracking loss pauses every effect, including color treatments and the face distortion. |
| **Import package…** | Opens the OS file picker and validates the selected ZIP (schema v1 or v2, declared assets only, bounded declarations, no executable content). A valid package is stored under the app's `userData` directory, appears in the Effect selector and is selected. An invalid package is rejected with its actionable code, message and field/path; the current output is unchanged. |
| **Remove imported effect** | Removes the selected imported package from the persistent store. If it was active, the selector falls back to `No effect` and the opaque paused output; other imported packages remain. |
| **Tracking state (diagnostic)** | `Use detected face (normal)`, or inject `tracking lost`, `multiple faces`, or `unreliable tracking` to exercise the output policy. Injected states are labelled in the diagnostics; the real detector is authoritative when set back to normal. |
| **Recheck input** | Re-runs fixture size/checksum validation. Use after fetching a fixture that was missing at launch. |
| **Capture evidence frame** | Writes the current output canvas (1280×720 PNG) to `evidence/` and shows the path in the app. |
| **Simulate effect-processing failure** | Diagnostic-only toggle that forces the failure policy to demonstrate the opaque paused output and automatic recovery. |
| **Restart virtual camera** | Re-runs the native camera host (for example after an elevated install or a camera error). |

The app never opens a physical camera in this slice. There is no passthrough mode: the output is
either a processed replay frame (with a mask, a color treatment, a bounded face distortion, or an
imported complete effect) or the opaque "Tracking paused" screen, in the preview **and** in the
virtual camera. While an imported
mask loads, the whole output stays on the opaque paused screen; a failed load leaves it hidden with
an explanation. Closing Shymask stops its camera output.

## What the output path does

- **Recorded input.** `fixtures/cache/webcam-loop.webm` is downloaded by `npm run fetch:fixture` and
  validated against the committed metadata (`fixtures/webcam-loop.json`). Invalid or missing media
  produces an actionable error and hidden output; `Start` stays disabled. A second, larger-motion
  recorded clip (`pose-loop-v1`) is available for the public-workflow check through
  `SHYMASK_FIXTURE_MANIFEST=pose-loop.json`; see [`docs/fixture-pose-loop.md`](docs/fixture-pose-loop.md).
- **Local asset protocol.** The renderer, the MediaPipe WASM fileset, the tracker model and the
  replay media are served from `shymask://app/...` (`src/main/asset-protocol.ts`) under a strict CSP
  (`default-src 'none'`, `script-src 'self' 'wasm-unsafe-eval'`, `connect-src 'self'`). This keeps
  WASM/model loading local and gives the `<video>` byte-range support; there is no network listener
  and no Windows API in the portable path.
- **One output canvas.** Every frame — processed, masked or paused — is drawn to the single `#output`
  canvas at 1280×720. That same canvas is what the virtual camera publishes; there is no second
  pipeline and no separate camera state machine. The only exception is the native opaque paused
  fallback, which the media source shows before the app's first frame and when app frames go stale.
- **Real-time loop.** The clip plays muted at rate 1 with `requestVideoFrameCallback` as the
  present-time scheduler. The processing timestamp is monotonic across loop seams:
  `loopIndex × clipDuration + mediaTime`. A loop seam is a deliberate media-time reset, not a
  tracking defect. A one-frame decode gap at a seam keeps the last processed frame visible rather
  than flashing the paused screen; a decode gap longer than 250 ms is treated as a processing
  failure and hides the output. A 50 ms timer watchdog covers the case `requestVideoFrameCallback`
  cannot report: if the decoder silently stops presenting frames for more than 250 ms while the
  preview is started, unpaused and an effect is active, the opaque paused screen replaces the last
  frame, and the next valid frame restores the output automatically. The watchdog is reset on Start,
  Resume, manual pause and Recheck input.
- **One-face tracking.** MediaPipe Face Landmarker (`@mediapipe/tasks-vision`, pinned) runs in the
  renderer on each presented replay frame and returns landmarks plus a rigid facial transformation
  matrix. `src/core/tracking.ts` applies the readiness/loss hysteresis: `initializing` until the
  first confirmed face, a 250 ms lost grace, 250 ms unreliable confirmation, 300 ms recovery
  confirmation, and an immediate pause for more than one face. `numFaces: 2` is deliberate so the
  policy can distinguish one person from more than one.
- **Rigid mask.** `src/renderer/mask-renderer.ts` builds a procedural low-poly helmet/visor in
  MediaPipe's canonical face units, attaches it to the facial transformation matrix (not screen
  coordinates), and renders it to an offscreen transparent WebGL canvas. An imported package's
  `.glb` is loaded with Three.js `GLTFLoader` into the **same mask scene**, with the manifest's
  declarative attachment, so the bundled and imported masks share one projection and composite
  path. `src/core/pipeline.ts` composites that canvas into the single output canvas. The camera
  uses MediaPipe's 63-degree vertical-FOV assumption, which is what makes the mask land on the
  face. Only a sample the tracking state machine classifies reliable updates the mask transform; a
  rejected sample (for example one implausible pose jump) keeps the previous accepted projection
  through the confirmation window, so a detector glitch cannot draw one teleported mask frame. See
  [`docs/notes/0003-face-tracking-and-mask.md`](docs/notes/0003-face-tracking-and-mask.md).
- **Failure policy.** The policy in `src/core/output-policy.ts` returns the opaque
  "Tracking paused" decision for startup, first-frame wait, missing/invalid fixture, missing/corrupt
  tracker model, no active effect, manual pause, effect-processing failure, an async effect switch,
  an invalid/removed active effect, a failed imported-effect load, tracking readiness, tracking
  loss, multiple faces, and unreliable tracking. Manual pause is evaluated before tracking and
  switching so automatic recovery or a switch cannot override it. It has no raw-passthrough branch.
- **Bounded face distortion.** `src/renderer/face-distortion-renderer.ts` applies one fixed radial
  shader (`bulge` or `pinch`) to the replay frame inside an ellipse recomputed every frame from the
  tracked face box (`src/core/face-distortion.ts`). The package supplies only a mode and bounded
  numbers (`strength` 0-1, `radiusScale` 0.25-2.5, `centerOffset` ±0.5), never geometry, shader code
  or per-frame displacement. The offscreen warp canvas is drawn through the same
  `src/core/pipeline.ts` output canvas, so preview and camera share one frame path; outside the
  ellipse the source pixels are untouched. The public **Face distortion** diagnostic reports the
  face box, ellipse, warp cost and a measured inside/outside change ratio. See
  [`docs/notes/0006-face-distortion.md`](docs/notes/0006-face-distortion.md).
- **Declarative effects.** Color treatments, the bundled rigid mask and the bounded face distortion
  are data/ids (`src/core/treatments.ts`, `src/core/effect-package-contract.ts`); an imported effect
  is a validated package descriptor
  (`src/core/effects.ts`, `src/core/effect-package-contract.ts`) whose mask is a declared GLB and
  whose treatment is a fixed filter built from bounded parameters. No arbitrary executable effect
  code is loaded, and the renderer never receives archive bytes. The package contract, validation,
  limits and error codes are documented in [`docs/effect-packages.md`](docs/effect-packages.md).
- **Effect package import.** `src/main/effect-packages.ts` validates the chosen ZIP with the pure
  validator (`src/core/effect-package.ts`, `src/core/zip.ts`, `src/core/glb.ts`), stores the
  validated archive and declared asset under `userData`, and serves only that asset from the local
  `shymask://app/packages/...` route. Validation rejects zip-slip, absolute paths, symlinks,
  oversized entries, executable/script content, unsupported schema versions, unknown behaviors,
  missing assets, out-of-range color or distortion parameters and unsupported glTF features with
  structured, actionable codes. Imported effects persist across restarts and can be removed in the
  app. The spike choices and replay-based package evidence are in
  [`docs/notes/0004-effect-packages.md`](docs/notes/0004-effect-packages.md); the face-distortion
  contract and evidence are in
  [`docs/notes/0006-face-distortion.md`](docs/notes/0006-face-distortion.md).
- **Virtual camera publication.** While the app runs, `src/main/virtual-camera.ts` serves the output
  canvas to the native Windows virtual camera over a loopback frame transport, and
  `src/renderer/renderer.ts` pushes every drawn output frame plus a 100 ms heartbeat (only while a
  camera consumer is connected). Startup, no effect, manual pause, processing errors, missing input,
  tracking loss, multiple faces, unreliable tracking and a missing model all appear in the camera as
  the same opaque "Tracking paused" canvas. A bundled treatment change is synchronous and renders the
  new treatment in the camera immediately; an imported effect switch keeps the camera on the paused
  canvas until the package assets are ready, so it never receives a stale or raw switch frame. The
  native opaque fallback covers only the pre-connection window. The camera uses `MFVirtualCameraLifetime_Session`, so closing Shymask stops the stream and
  removes the device.

## Windows virtual camera (issue #3)

Windows 11's Media Foundation software camera source is used (`MFCreateVirtualCamera`) with a
session-lifetime COM media source. All Windows camera code stays under `native/`; the renderer and
`src/core` never link Media Foundation, so a future macOS integration can replace the native
integration without touching the portable processing path.

The media source is an in-proc COM class that the **Windows frame server** activates as
`NT AUTHORITY\LocalService`, so the registration must be machine-wide:

```
HKLM\Software\Classes\CLSID\{5E1D3A6B-2C4F-4A7E-9B8D-0C1F2A3B4C5D}\InprocServer32
    (default)      C:\ProgramData\Shymask\bin\ShymaskVirtualCamera.dll
    ThreadingModel Both
```

That is why the first install is elevated. The install also stages the binaries in
`C:\ProgramData\Shymask\bin` (readable by Local Service) and grants the installing user modify
access, so later `npm run vcam:install` runs restage rebuilt binaries **without** elevation while the
machine-wide registration stays in place.

### Prototype trust boundary

This virtual camera is a **single-user development-machine prototype**, not a hardened system
component. The elevated install and the ACL grant are development conveniences, and they are a real
security trade-off rather than a harmless permission tweak:

- The HKLM registration makes the Windows frame server (`NT AUTHORITY\LocalService`) load
  `C:\ProgramData\Shymask\bin\ShymaskVirtualCamera.dll`. The installer's modify grant on
  `C:\ProgramData\Shymask` is inherited by that DLL and by `vcam-port`. A standard user in the
  installing account can therefore replace the DLL the Local Service frame server loads, and can
  rewrite `vcam-port` to point the camera at a different local frame server.
- The camera pipeline also trusts local same-user processes: any process in the account can read the
  loopback frame transport and compete for the port the media source connects to. That is acceptable
  for a local development prototype and is **not** a multi-user security boundary.
- Do not use this build on a shared, multi-user, or production machine. A production integration
  needs a non-user-writable staging path, a service-owned frame transport, and authentication
  between the app and the media source.

To revoke both the registration and the ACL grant, use an elevated prompt:

```powershell
# Removes the per-user and machine-wide COM registration.
npm run vcam:uninstall

# Removes the modify ACE granted to the installing user; staged files remain.
icacls "$env:ProgramData\Shymask" /remove:g "$env:USERDOMAIN\$env:USERNAME" /T
```

`npm run vcam:uninstall` does not remove the staged binaries, `vcam.log`, or the ACL entry, and a
non-elevated uninstall leaves the machine-wide registration in place.

```powershell
npm run build:native # rebuild the COM media source, camera host and consumer harness
npm run vcam:install # stage binaries + (elevated first time) machine-wide registration
npm run vcam:status  # enumerate Media Foundation camera devices ("Shymask Camera (Windows Virtual Camera)")
npm run vcam:check   # native-only workflow: test-pattern source -> host -> independent consumer
npm run vcam:uninstall # remove the per-user registration (and machine-wide when elevated)
```

`npm run vcam:check` exits `0` when the independent consumer receives frames and `3` when the camera
cannot start (it records the HRESULT, registry state and frame-server events in
`evidence/vcam-check/summary.json`). The machine-wide registration is intentionally left installed
on this development machine; uninstall is documented for cleanup.

The camera publishes **RGB32 1280×720 at 30 FPS**. The media source allocates samples from the
allocator the frame server provides (`IMFSampleAllocatorControl`), which is required for frames to
reach a consumer process. It also applies a **1200 ms freshness bound** to the cached app frame: if
the connected renderer stops sending (a hung renderer, socket still open), the media source delivers
the native opaque paused fallback instead of freezing the last processed frame, and a recovered
renderer restores processed output as soon as a complete frame arrives. NV12 and real call
applications are not implemented here; that is issue #10. See
[`docs/notes/0002-windows-virtual-camera-spike.md`](docs/notes/0002-windows-virtual-camera-spike.md)
for the architecture, the registration failure that was investigated, and the measured results.

## Checks

```powershell
npm run typecheck        # strict TypeScript across src and tests
npm test                 # unit tests for the output policy, tracking state machine, bounded pose
                         # smoothing, replay clock, frame watchdog, treatments, package schema/ZIP
                         # safety/GLB validation, face-distortion geometry/validation and the effect
                         # registry (129 tests)
npm run build:face-occluder # regenerate the committed canonical face-occluder table (fetches once)
npm run build:packages   # regenerate the committed sample + negative effect-package fixtures
npm run validate:package -- <file.zip>  # validate one package with the app's pure validator
npm run check            # builds TypeScript + native camera, stages it, launches the real Electron app with
                         # Playwright, drives public controls, runs the independent Media Foundation camera
                         # consumer, and writes screenshots + camera frames + summary.json under
                         # evidence/check-<timestamp>/
npm run check:all        # npm test && npm run check
```

`npm run check` requires the native camera prerequisites (MSVC + Windows 11 SDK) and the
machine-wide registration from the one-time elevated `npm run vcam:install`. It builds and restages
the native components so the tested binaries match the committed sources. It also needs the pinned
Face Landmarker model and the larger-motion fixture; fetch them once with:

```powershell
npm run fetch:tracker
npm run fetch:motion-fixture
```

The public-workflow check asserts, through the app's visible controls, its diagnostics and the
independent camera consumer (79/79 checks passed in the latest run at this head):

1. Startup is the opaque "Tracking paused" screen; no raw feed.
2. Start renders a processed replay frame through the treatment control.
3. Warm, cool and monochrome treatments visibly change the output (measured as mean RGB of the
   output canvas); monochrome is near-neutral.
4. `No effect` returns to the opaque paused screen, and selecting an effect restores output.
5. Manual pause persists, freezes processing timestamps, and Resume continues them.
6. The replay completes at least three more loops with strictly increasing processing timestamps,
   near real-time pacing, and reported seams that match independent backward media-time jumps in
   the sampled diagnostics (not the loop counter that increments alongside them).
7. A missing fixture and a checksum-corrupt fixture each show an actionable error, hide output and
   keep Start disabled.
8. The public capture control writes a valid 1280×720 PNG of the output canvas.
9. No renderer console errors occur, and no physical-camera API appears in application source.
10. A silent decode stall (media element paused directly, bypassing the manual Pause control) hides
    the output behind the opaque paused screen after the 250 ms watchdog and recovers on the next
    frame.
11. Recheck after enabling the diagnostic failure toggle clears the injected failure and recovers
    the processed preview on Start.
12. Rechecking a second, differently corrupt fixture replaces the stale error explanation with the
    new failure message.
13. `Shymask Camera` is registered and enumerable by a separate Media Foundation consumer process.
14. Camera startup, no effect, manual pause, injected processing failure and missing input all
    deliver the opaque "Tracking paused" canvas to the camera consumer (mean RGB ≈ 12,15,20). The
    assertion requires at least one app-published frame (`captureUnixMs > 0`) and decodes the saved
    PNG, so the native pre-connection fallback cannot satisfy a paused state by itself.
15. Processed replay frames in the camera match the preview's treatment (warm, cool), effect
    switches and pause/resume change the camera output, and recovery is automatic. Each processed
    state's saved PNG is decoded from disk and asserted against the same processed colour.
16. The camera receives a continuous 30 FPS sample stream across multiple replay loops.
17. A replay-based replay-to-camera latency baseline is recorded.
18. Closing the app stops camera frames, exits the camera host process, and removes the camera from
    device enumeration; a consumer timeout is accepted only with zero late frames and device
    removal, and that acceptance is recorded explicitly.
19. Face-tracker assets are validated before Start; the model is ready and the recorded replay
    produces exactly one face with full landmarks and a transform.
20. The rigid mask is attached to the tracked face (origin inside the face bounding box expanded
    by 35% of its width/height, sized to it) and the output pixel at its cyan eye plate is the exact
    mask colour when the probe is visible.
21. Mask position and orientation change with the recorded head motion, frame by frame, while the
    mask origin stays inside the expanded tracked-face bounding box.
22. The camera consumer receives the same masked canvas: its saved PNG mean matches the preview and
    contains the mask eye plate at the expected probe colour.
23. Injected tracking loss replaces the whole output with the exact opaque paused screen in preview
    and camera, and the selected mask returns automatically when the injection clears.
24. Injected multiple faces and unreliable tracking each pause the whole output in preview and
    camera, and both recover automatically.
25. Manual pause is not overridden by automatic tracking recovery.
26. Tracking loss pauses the existing color treatment too, and recovery restores it.
27. A missing tracker model and a corrupt (checksum-mismatched) model each show an actionable
    hidden-output error, disable Start, and keep the camera on the paused canvas; the recovery
    command is `npm run fetch:tracker`.
28. On the second recorded CC0 clip, a documented 8 s window with real turns, nods and leaning keeps
    exactly one face tracked and moves/rotates the mask by at least 12° of yaw and pitch and 40 px of
    origin movement, with screenshots at three points in the turn. The camera-side motion evidence is
    captured on the held 47.7 s motion-window frame (the moving behavior is the sampled window plus
    those screenshots); resuming live playback after the long held A/B is not used as evidence because
    the automated session can occasionally stall its video frame-callback timestamps after a loop seam
    (the output then correctly hides under the paused policy).
29. Face occlusion is active in the normal preview and camera path. Two held side-view frames in
    opposite yaw directions (47.7 s, about −20° to −22°, and 16.0 s, about +9° to +14°) are compared
    with only the depth-only canonical face occluder disabled: the bundled mask changes
    ~15.7k–17.4k pixels, with 88%+ inside the tracked-face **bounding box** (~89–94%), ~5.3k–5.7k for
    `guard-visor` (94.5–96.5% inside that bbox) and ~2.3k for `rose-visor` (100% inside that bbox).
    ON and OFF are each captured twice and each same-state pair is pixel-identical, and the
    independent camera's total and inside-bbox change counts are asserted equal to the preview's for
    the bundled mask and `guard-visor` (there is no `rose-visor` camera A/B). The ON frame is also
    proved to reveal non-mask content: the imported package's exact unlit material colour covers ≥97%
    of the changed pixels in OFF and ≤3% in ON (observed 0.3–1.5%), while the bundled mask's dominant
    rendered palette (top 64 exact shades, ≥90% coverage) does not reappear in ON (≤1%, observed
    ≤0.1%, including 4 px in one opposite-view run).
    The ON changed pixels must additionally pass a plausible-video floor (mean luminance ≥30,
    luminance stddev ≥6, ≤10% near-black, ≥16 distinct colours), and for the untreated bundled mask
    and `rose-visor` ≥90% of sampled ON pixels must match the held replay frame drawn at the pipeline
    scale (observed across recent runs: bundled ~125–130 mean luminance / ~32–36 stddev, `rose-visor`
    ~149–151 / ~13–14.5, opposite-view bundled ~102–105 / ~40–41; held-replay match 0.93–0.97). This
    proves mask material is removed and plausible video is revealed; the saved PNGs show the face, but
    it is not an exact-colour proof of identity. The occlusion A/B therefore covers bundled and
    imported masks through the same renderer path: both turn directions for the bundled mask and
    `guard-visor`, and the primary view for `rose-visor`.
30. Bounded face anchoring is measured against raw tracking on the same recorded frames. The initial
    ~2 s segment is measured, not assumed, to be slow (pose span about 5.6–8.5° yaw, 6–9° pitch, ~2°
    roll and 11–14 px origin, p50 alpha ~0.33–0.34; enforced bounds 10°/10°/5°, 30 px and p50 alpha
    ≤0.4). Slow-segment p95 jitter drops from about 3.7–4.2 px / 2.4–2.7° raw to about 1.5–2.3 px /
    1.0–1.4° smoothed (40–66% origin and 43–59% rotation lower; enforced gates smoothed ≤0.80× raw
    origin and ≤0.85× raw rotation; recent runs measured 1.72–2.24 px / 41.6–55.3% origin and
    1.09–1.36° / 43–59% rotation). Across the full
    turn/nod/lean window the rendered mask origin's p95 sliding relative to the face-box centre is
    a bounded measured value of ~12–16 px (about 5–7% of face width; enforced bound 24 px;
    earlier runs up to ~20 px), not a claim that it does not slide. The same documented window is
    sampled again through the public raw Pose smoothing mode: observed runs measured raw-mode p95
    ~9–13 px vs rendered ~12–16 px, so smoothing did not reduce this proxy metric (the rendered
    pass was about 2–77% higher, consistent with filter lag and frame-timing differences); its
    measured benefit is the slow-segment jitter reduction above. The face-box centre shifts under yaw,
    so the metric is a proxy and no correction is claimed: acceptance criterion 2's sliding is
    bounded, not corrected (jitter is reduced and clipping is addressed by the occluder). The raw
    origin-to-centre offset p95 is ~29–34 px (bound 60 px), and the p95
    raw-vs-smoothed lag is ~3.6–4.3 px / ~1.7–1.9° with a ~60–62 ms constant-velocity delay; the
    filter costs ~0.1 ms p95.
31. A valid generated package imports through the public **Import package…** control (only the OS file
    picker is stubbed), appears in the Effect selector, and renders its packaged GLB mask + declared
    color treatment in the preview. The exact unlit material colour appears in exact 1280×720 preview
    and camera PNGs (enforced >20,000 px for guard and >25,000 for rose; about 31k–33k for guard and
    about 39k–41k for rose across recent runs; some runs measured 40,025 and 40,943 for rose), so the
    packaged asset — not the bundled mask — is composited. Face occlusion can
    hide the bounding-box-centre probe; the preview probe is asserted
    by reading the actual saved ON PNG pixel when the public diagnostic reports it visible, and the
    camera probe is asserted under the same condition.
32. The independent camera consumer receives the same imported mask + treatment: its saved PNG mean
    matches the preview and contains the package material colour.
33. A color-treatment-only package visibly changes the preview and camera output through the same path.
34. Switching bundled → imported → imported paints the opaque paused output first and completes;
    manual pause persists across a switch and keeps the camera paused; an imported effect honors
    tracking-loss/multiple-face/unreliable gates and recovers automatically; an invalid/removed
    selection falls back to the no-effect paused output. A rapid double switch commits only the
    later package's mask, and a mask-only package (`rose-visor`) with nonzero position/rotation/scale
    renders in preview and camera.
35. Malformed JSON, unsupported schemaVersion, unsupported behavior, missing asset, invalid color,
    zip-slip, oversized entry, executable content, an unsupported glTF extension, a glTF camera and
    missing accessor `componentType`/`type` are each rejected with their documented actionable code,
    keep the previous effect rendering, and cause no crash or renderer console error. Removing the
    active imported effect leaves the paused no-effect output, and another imported package still
    renders after an app restart.
36. The schema v2 `face-distortion` sample imports through **Import package…**, appears in the Effect
    selector, is selected, and reports `mode=bulge`, `strength=0.6`, `radiusScale=1.35` and the
    tracked face box in the public **Face distortion** diagnostic. The warp ellipse's centre follows
    the face box centre and its radii scale with the face box; the same-frame 64×36 warp-delta
    measurement shows pixels changed inside the ellipse and (near) none outside it. An exact
    1280×720 preview PNG and an independent camera PNG both show processed (non-paused) content.
37. On the recorded turn/nod/lean window, the distortion ellipse's centre moves at least 30 px with
    the tracked face, every sampled frame passes the inside/outside change gates, and three
    screenshots are saved. This distinguishes a face-following distortion from a static overlay.
38. The distortion follows every paused-output rule in preview and camera: manual pause, injected
    tracking loss, injected multiple faces, injected processing failure, switching to an imported
    mask (paused while it loads) and back, explicit `No effect`, and removal of the active package
    all show the opaque paused canvas in both paths; recovery is automatic after the injection
    clears. The four distortion negative fixtures (v1 declaration, unsupported mode, out-of-range
    strength, unknown field) are rejected with `schema-version-unsupported` or `distortion-invalid`
    and leave the previous effect rendering.
39. Replay-based timing for the distortion path is recorded at 1280×720: the offscreen warp cost, the
    full render/composite cost and the presented-frame interval, plus a color-only package baseline
    on the same fixture. These are observations for the later complete-effect benchmark, not the
    final performance target.

Artifacts are written to the gitignored `evidence/check-<timestamp>/` directory: per-state canvas
screenshots, the full app window (including import-error feedback), captured output frames,
camera-consumer PNGs under `camera-frames/`, and `summary.json` with the derived base SHA, timing
baseline, tracking/model evidence, effect-package import/negative/rapid-switch/attachment evidence
(including the displayed complexity subset in each import message), face-distortion preview/camera,
motion-following and replay-based timing evidence, hardware, workload, measured
boundaries, commands, validation-gate facts and the tested head SHA. It also records
`virtualCamera.captureAttempts`: every processed camera capture's attempt count and its
app-published/native-fallback frame counts, so the bounded retries and the consumer-frame capture
window (8 frames, 10 for the motion-window capture) are visible in the evidence. The check uses an
evidence-local `SHYMASK_PACKAGE_DIR`, so it never edits installed packages; the committed sample and
negative package fixtures are regenerated with `npm run build:packages`.

`npm run vcam:check` independently exercises the native path: it asserts the test-pattern pixels and
that a connected frame source which stops sending (socket kept open) is replaced by the native opaque
paused fallback. The media source applies a 1200 ms freshness bound to the cached app frame; the
harness accepts a transition gap of 800–3000 ms (measured from the last coloured frame's capture
time to the first dark frame's receive time), and the validated run recorded a 1234 ms gap in
`evidence/vcam-check/summary.json` (1233–1258 ms across recent runs).

### Measured baseline (replay-based, virtual camera)

From a passing `npm run check` run on 2026-11-13 (the head SHA validated by the latest full check run
is recorded in `evidence/check-<timestamp>/summary.json`, `evidence/vcam-check/summary.json`, and
`evidence/logs/*-final.log`; later documentation-only commits do not change the validated behavior),
source clip 3.379 s:

- **Hardware:** 11th Gen Intel Core i7-11700K (8 cores / 16 logical), NVIDIA GeForce RTX 3070 Ti,
  31.8 GiB RAM, Windows 11 Pro 10.0.26100 (build 26100). Node.js 24.19.0, Electron 45.3.1.
- **Workload and source mode:** recorded replay fixture `fixtures/cache/webcam-loop.webm` decoded by
  Chromium; Electron preview publishing its output canvas as the `Shymask Camera` virtual webcam; an
  independent Media Foundation Source Reader process consumes the camera. No physical webcam or call
  application is in the path.
- **Commands:** `npm run typecheck`, `npm test`, `npm run check`, `npm run vcam:check`.

| Measurement | Value |
| --- | --- |
| Camera media type | RGB32 1280×720 @ 30/1 |
| Camera frames observed | 212 over 6.89 s (30.5 Hz sample rate) |
| Camera frame interval, p95 | 47 ms |
| Replay-to-camera latency, p50 / p95 | 33 ms / 56 ms in the latest run (32–37 / 55–77 ms across recent runs; canvas capture time → consumer receive time) |
| Camera mean-RGB spread across the window | 19 (replay content changes across loops) |
| Replay loops crossed during the camera window | 2 |
| Source frame interval, p95 | 48.8 ms in the latest run; ~42–55 ms across passing runs (the clip presents at ~18–24 Hz here; no 30 FPS forcing) |
| Render + filter cost, p95 | 16.9 ms in the latest run (main-thread draw/filter plus the diagnostics mean-RGB sample; a connected camera adds canvas readback) |
| Mask render + composite cost, p95 | 10–15 ms across recent runs (offscreen mask render plus the drawImage composite into the output canvas, including the diagnostics sample) |
| Tracker inference, steady-state p95 | 13.2–13.8 ms per presented frame |
| Tracker inference, first-call warm-up | ~0.28 s in recent runs; ~0.3–2.0 s observed across runs (excluded from the p95) |
| Default-clip mask motion (~2.5 s sample) | origin moved ~7 px horizontally / ~3 px vertically; yaw ~3.5°, pitch ~2.1° (a longer manual sample saw ~12 × 23 px) |
| Recorded motion-window swing (41.6–49.6 s) | enforced minimums yaw/pitch ≥12°, roll ≥4°, origin ≥40 px; observed across recent runs yaw ~24–29°, pitch ~23–35°, roll ~12–19°, mask origin ~91–99 × ~44–77 px, 17–18/18 sampled frames tracked (a representative run 27.0° / 28.9° / 17.8°, 98 × 60 px, 18/18); projected-origin sliding p95 ~12–16 px (bound 24 px; raw-mode ~9–13 px; earlier runs up to ~20 px rendered), raw origin-to-face-centre offset p95 ~29–34 px (bound 60 px) |
| Slow-segment pose jitter, p95 | raw 3.7–4.2 px / 2.4–2.7° → smoothed 1.5–2.3 px / 1.0–1.4° (40–66% origin, 43–59% rotation lower; enforced gates smoothed ≤0.80× raw origin and ≤0.85× raw rotation; recent runs measured 1.72–2.24 px / 41.6–55.3% origin and 1.09–1.36° / 43–59% rotation; paired over the same frames). The segment is measured to be slow: about 5.6–8.5° yaw / 6–9° pitch / 2° roll span, 11–14 px origin, p50 alpha ~0.33–0.34 |
| Smoothing added lag / cost | p95 raw-vs-smoothed offset 3.6–4.3 px origin and 1.7–1.9° rotation; implied constant-velocity delay p95 60.2–61.6 ms; filter cost 0.1 ms p95. The ~50.9 ms reference-interval figure is not a global maximum (effective alpha ~0.34 at the observed ~35 ms interval) |
| Occlusion A/B at two turned frames (47.7 s about −20° to −22°, 16.0 s about +9° to +14°) | bundled mask 15,705–17,414 px changed (89–94% inside the tracked-face bbox); `guard-visor` 5,319–5,700 px (92–96.5%); `rose-visor` 2,257–2,306 px (100%); same-state repeats pixel-identical. ON reveal is proved by exact colour: package material ≥97% of changed pixels in OFF and ≤3% in ON (observed 0.3–1.5%); bundled dominant palette ≥90% coverage and ≤1% reappearance in ON (observed ≤0.1%, including 4 px in one opposite-view run) |
| Occlusion camera A/B | the independent consumer received the same change on the held frame: total and inside-bbox pixel counts are asserted equal to the preview's for the bundled mask and `guard-visor`, with 0 same-state self-diff |
| Face-distortion warp pass, p95 | 0.4 ms at 1280×720 (offscreen WebGL radial-warp pass, rolling p95 after warm-up) |
| Face-distortion render + composite, p95 | 14.9 ms vs 13.9 ms for the color-only baseline on the same fixture (observed +1.0 ms, including the diagnostics sampling) |
| Face-distortion presented-frame interval, p95 | 65.2 ms vs 48.8 ms in the sequential comparison; this difference exceeds the 0.4 ms warp cost and the two windows are not isolated, so it is reported as observed run variation, not attributed added cost |
| Face-distortion pixel evidence (default clip) | about 70% of inside-ellipse samples changed vs 0.0% outside; warp delta about 0.9–1.1 (0–255 mean absolute); the exact 1280×720 preview PNG and the camera PNG both show non-paused processed content |
| Face-distortion recorded-motion following | 18/18 sampled frames tracked on `pose-loop-v1`; warp centre moved about 91 × 80 px with the tracked face box; inside-ellipse change about 60% (every sample passes the ≥8% inside / ≤3% outside gates) |
| Loop cycles observed | 3 seam crossings inside an 8.36 s sampling window |
| Independent seam validation | 3 backward media-time jumps matched 3 reported seams |
| Replay pacing ratio | 0.999 processing time / wall time in the latest run |

Effect-package evidence from the same run (replay-based): the committed `guard-visor` sample is a
1,715-byte archive with 2 entries and a 693-byte manifest, containing a 2,284-byte GLB with 96
triangles, 1 mesh, 1 material and 1 node; `verdant-tint` is a 397-byte color-only archive. The
imported mask's unlit material colour (RGB 225,29,154) appears in exact 1280×720 preview and camera
PNGs (about 31,000–33,000 pixels in recent runs; enforced >20,000), so the packaged asset is
composited through the shared path. Face occlusion can legitimately hide the package's
bounding-box-centre probe; the preview probe is asserted by reading the actual saved ON PNG pixel when
the public diagnostic reports it visible, the camera probe is asserted under the same condition, and
the exact material-colour count is always asserted.
`rose-visor` is a mask-only sample with nonzero `position`/`rotationDeg`/`scale` whose distinct
material colour (RGB 32,196,128) is asserted in both preview and camera (about 38,000–40,000 pixels;
enforced >25,000), and a rapid double switch must leave only the later package's mask committed.
`face-distortion` is a 415-byte schema v2 distortion-only archive whose public diagnostic reports the
tracked face box and the resolved ellipse; a same-texture identity-vs-warped comparison changed about
70% of inside-ellipse samples and 0.0% outside, and both the preview PNG and the independent camera PNG
showed non-paused processed content. The schema v2 sample and the four distortion negative fixtures
are generated by `npm run build:packages`; replay-based timing for the distortion path is recorded
for the later complete-effect benchmark (see the table below and
[`docs/notes/0006-face-distortion.md`](docs/notes/0006-face-distortion.md)).
Package complexity is reported, not budgeted; no triangle/mesh threshold is asserted.

Replay-derived tracking measurements from the same run are documented in
[`docs/notes/0003-face-tracking-and-mask.md`](docs/notes/0003-face-tracking-and-mask.md); the
occlusion and smoothing method, trade-offs and limits are in
[`docs/notes/0005-face-occlusion-and-anchoring.md`](docs/notes/0005-face-occlusion-and-anchoring.md).
The default clip's recorded motion is deliberately small (it has no large turns or nods); the
larger-motion CC0 fixture supplies the turn/nod/lean evidence and is used only by the check.

Run-to-run variation is expected under desktop load; these are observations, not benchmarks. The
numbers are replay-derived. They do **not** establish the parent spec's 720p/30 FPS / ≤100 ms
camera-to-output target, physical-camera compatibility, tracking on a physical camera, call-application
compatibility, or laptop integrated-graphics suitability. The camera latency includes the app's ~30 Hz
publish cadence (a frame waits up to one 33 ms sample slot), so p95 is dominated by pacing rather than
transport. The mask has face-based occlusion and bounded face anchoring but no secondary motion; the
canonical face occluder is rigid, has no hair/ears/neck or full head silhouette, and does not deform
with expressions, and the policy cannot detect every possible visual defect. The packaged face
distortion is a bounded whole-face radial warp (`bulge`/`pinch`) whose ellipse follows the tracked
face box; it is not a per-landmark/expression warp or a 3D mesh deformation. See
`docs/notes/0001-preview-stack-and-loop.md`,
`docs/notes/0002-windows-virtual-camera-spike.md`,
`docs/notes/0003-face-tracking-and-mask.md`,
`docs/notes/0005-face-occlusion-and-anchoring.md` and
`docs/notes/0006-face-distortion.md`.

## Fixtures

The default input is a CC0-1.0 webcam-style recording of one person facing the camera
(`webcam-loop-v1`). A second CC0 Wikitongues clip (`pose-loop-v1`, 49.6 s, 480p) supplies real head
turns, nods and leaning for the tracking check and the face-distortion motion-following evidence; the
app's default input is unchanged. Their source,
license, attribution, checksums, acquisition commands, content coverage and gaps are documented in
[`docs/fixture-webcam-loop.md`](docs/fixture-webcam-loop.md) and
[`docs/fixture-pose-loop.md`](docs/fixture-pose-loop.md). Media bytes and the face-tracker model are
intentionally not committed; only fetch scripts and metadata are versioned (`tracker/face-landmarker-model.json`).

## Layout

```
src/core/       output policy, tracking state machine, bounded pose smoothing, replay clock, canvas
                pipeline, effects, effect-package contract/validator, ZIP safety reader, GLB validator
src/main/       Electron main process, local asset protocol, fixture/tracker validation, effect-package
                store/import/remove, IPC, virtual camera lifecycle
src/renderer/   desktop preview UI (HTML/CSS/TS), MediaPipe tracker wrapper, Three.js mask renderer
                with the depth-only canonical face occluder (bundled + package GLB), the fixed
                face-distortion shader, and camera frame publication
scripts/        build, start, fixture/model fetch, canonical face-occluder generation, package fixture
                generation/validation, public-workflow check, native camera scripts
native/         Windows virtual camera: Media Foundation media source, host, consumer harness
tests/          focused unit tests (node:test)
fixtures/       committed fixture manifests and effect packages; fetched media is gitignored
tracker/        committed Face Landmarker model metadata (source, license, SHA-256); model is gitignored
docs/           fixture notes, preview/loop + virtual camera + tracking + effect-package notes, ADRs
```

## Environment notes and troubleshooting

- Runtime is entirely local: no account, telemetry, or cloud calls. The fixture and model fetches are
  the only network use, and they happen before the app starts.
- If Electron exits immediately under a shell that exports `ELECTRON_RUN_AS_NODE=1`, `npm start`
  strips that variable for the child process. Use `npm start` rather than invoking `electron`
  directly in such an environment.
- **Missing fixture:** the status area names the expected path and `npm run fetch:fixture`; fetch it
  and press **Recheck input**.
- **Checksum or size mismatch:** delete `fixtures/cache/webcam-loop.webm`, re-run
  `npm run fetch:fixture`, then press **Recheck input**. Do not edit the committed checksum without
  reviewing the upstream source.
- **Missing or corrupt face-tracker model:** the status area shows "The face-tracker model is
  missing/corrupt" with `npm run fetch:tracker` and `npm run build`; the output stays hidden and
  **Start** is disabled. After fetching, restart the app (the model is validated at launch).
- **WebGL2 unavailable:** the mask renderer cannot start. The app reports that the face tracker could
  not start and keeps the output hidden; there is no camera or raw-frame fallback.
- **No visible window in a headless session:** the preview is a desktop GUI. `npm run check` needs a
  Windows desktop session because Playwright drives a real Electron window.
- **Camera not listed in other apps:** run `npm run vcam:status`; look for
  "Shymask Camera (Windows Virtual Camera)". If missing, run `npm run vcam:install` once from an
  elevated prompt and press **Restart virtual camera**.
- **Camera does not start:** `%ProgramData%\Shymask\vcam.log` and
  `evidence/vcam-check/summary.json` record the native HRESULT and frame-server events.
  `0x80070003` means the machine-wide registration is missing or stale (elevated
  `npm run vcam:install`); `0x80070005` points at Windows camera privacy settings.
- **Camera connected but no frames:** the consumer harness (`npm run vcam:check`) is the fastest
  oracle; a stalled consumer now times out with JSON instead of hanging. A connected app that goes
  silent (hung renderer) is replaced by the native opaque paused fallback after 1200 ms rather than
  freezing the last processed frame.
- **An imported package is rejected:** the app shows the first validation code, the field or archive
  path and an actionable message; the current effect and output are unchanged. `npm run
  validate:package -- <file.zip>` gives the full structured result without opening the app. Common
  fixes are covered in [`docs/effect-packages.md`](docs/effect-packages.md#validation-error-codes).
- **Imported effects disappeared:** the store revalidates `package.zip` on every launch and ignores a
  package that no longer passes validation (the package summary shows the warning). Re-import it, or
  remove it with **Remove imported effect**.
- The check harness accepts `SHYMASK_FIXTURE_DIR`, `SHYMASK_EVIDENCE_DIR`, `SHYMASK_FIXTURE_MANIFEST`,
  `SHYMASK_TRACKER_DIR` and `SHYMASK_PACKAGE_DIR` to point at different media/evidence/asset/package
  directories. The app honors the same variables; the checks use them to exercise missing/corrupt
  fixture and tracker states, the larger-motion fixture and an isolated package store.

## Scope boundaries

Delivered by this slice: recorded input acquisition and validation, real-time looping, monotonic
processing timestamps, selectable declarative effects (color treatments, a bundled rigid mask, and
imported validated effect packages combining a declared GLB mask, a bounded face distortion and/or
bounded color treatment, schema v1/v2),
one-face tracking with readiness/loss hysteresis, face-based occlusion through a depth-only canonical
face mesh, bounded pose smoothing measured against raw tracking, the opaque paused-output policy in
the preview and the virtual camera (including tracking loss, multiple faces, unreliable tracking,
missing/corrupt tracker assets, async effect switching and failed imported-effect loads),
import/remove persistence under `userData`, Windows 11 virtual camera publication as
`Shymask Camera`, an independent Media Foundation consumer harness, and reproducible local checks
with no physical camera or human participation. The imported-effect async switch is the
switching-interruption sub-case: the whole output stays on the opaque paused screen until the new
effect loads, or remains hidden with an explanation if the load fails.

Deferred: physical webcam capture, live-human acceptance, secondary motion (issue #8), the
Blender/AI authoring flow (issue #9), real Zoom/Meet/OBS compatibility (issue #10),
final live acceptance, NV12 support, complexity budgets (issue #11), laptop integrated-graphics
validation, and the 720p/30 FPS / ≤100 ms target. Two-person footage is not part of this slice;
multiple faces are exercised through a labelled diagnostic injection and the `numFaces: 2` detector
configuration. Hand-over-mask occlusion remains out of scope. The face distortion is a bounded
whole-face radial warp with two modes; per-landmark/expression warps and package-supplied distortion
meshes or shaders remain unsupported.
