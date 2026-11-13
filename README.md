# Shymask

Shymask applies visual effects to a webcam feed and publishes the result as a virtual webcam. This
repository currently delivers a **recorded-replay preview** (issue #2), the **Windows 11 virtual
camera** (issue #3), and **one-face tracking with a basic rigid 3D mask** (issue #4): a desktop
preview loops a recorded webcam-style clip at real-time pacing, tracks exactly one face, attaches a
procedural low-poly mask to that face, displays a selectable effect, and publishes its 1280×720
output canvas as **Shymask Camera** so other applications can select it. The camera publishes the
app's output canvas; a native opaque paused fallback covers the short window before the app connects
and is used when app frames stop arriving. No physical webcam, account, cloud service, or live test
subject is used.

Tracking readiness and loss gate every effect: zero faces, multiple faces, unreliable tracking, a
missing tracker model, no effect, manual pause and processing failures all replace the whole output
with the exact opaque "Tracking paused" screen in both the preview and the virtual camera. There is
no raw-passthrough branch.

Effect packages, occlusion refinement, secondary motion, real call-application compatibility (issue
#10), and the final 720p/30 FPS / 100 ms target are later child tickets of the parent spec.

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
| **Effect** | `Rigid mask`, `Warm tint`, `Cool tint`, `Monochrome`, or explicit `No effect`. Choosing `No effect` hides the output; choosing an effect restores it automatically once one face is tracked. Tracking loss pauses every effect, including the color treatments. |
| **Tracking state (diagnostic)** | `Use detected face (normal)`, or inject `tracking lost`, `multiple faces`, or `unreliable tracking` to exercise the output policy. Injected states are labelled in the diagnostics; the real detector is authoritative when set back to normal. |
| **Recheck input** | Re-runs fixture size/checksum validation. Use after fetching a fixture that was missing at launch. |
| **Capture evidence frame** | Writes the current output canvas (1280×720 PNG) to `evidence/` and shows the path in the app. |
| **Simulate effect-processing failure** | Diagnostic-only toggle that forces the failure policy to demonstrate the opaque paused output and automatic recovery. |
| **Restart virtual camera** | Re-runs the native camera host (for example after an elevated install or a camera error). |

The app never opens a physical camera in this slice. There is no passthrough mode: the output is
either a processed replay frame (with the mask or a color treatment) or the opaque "Tracking paused"
screen, in the preview **and** in the virtual camera. Closing Shymask stops its camera output.

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
  coordinates), and renders it to an offscreen transparent WebGL canvas. `src/core/pipeline.ts`
  composites that canvas into the single output canvas. The camera uses MediaPipe's 63-degree
  vertical-FOV assumption, which is what makes the mask land on the face. Only a sample the tracking
  state machine classifies reliable updates the mask transform; a rejected sample (for example one
  implausible pose jump) keeps the previous accepted projection through the confirmation window, so a
  detector glitch cannot draw one teleported mask frame. See
  [`docs/notes/0003-face-tracking-and-mask.md`](docs/notes/0003-face-tracking-and-mask.md).
- **Failure policy.** The policy in `src/core/output-policy.ts` returns the opaque
  "Tracking paused" decision for startup, first-frame wait, missing/invalid fixture, missing/corrupt
  tracker model, no active effect, manual pause, effect-processing failure, tracking readiness,
  tracking loss, multiple faces, and unreliable tracking. Manual pause is evaluated before tracking
  so automatic recovery cannot override it. It has no raw-passthrough branch.
- **Declarative effects.** Color treatments and the bundled rigid mask are data/ids
  (`src/core/treatments.ts`): filters are declarative canvas expressions and the mask is a bundled
  procedural effect. No arbitrary executable effect code is loaded.
- **Virtual camera publication.** While the app runs, `src/main/virtual-camera.ts` serves the output
  canvas to the native Windows virtual camera over a loopback frame transport, and
  `src/renderer/renderer.ts` pushes every drawn output frame plus a 100 ms heartbeat (only while a
  camera consumer is connected). Startup, no effect, manual pause, processing errors, missing input,
  tracking loss, multiple faces, unreliable tracking and a missing model all appear in the camera as
  the same opaque "Tracking paused" canvas. A treatment change itself is synchronous and renders the
  new treatment in the camera immediately. The native opaque fallback covers only the pre-connection
  window. The camera uses `MFVirtualCameraLifetime_Session`, so closing Shymask stops the stream and
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
npm run typecheck   # strict TypeScript across src and tests
npm test            # unit tests for the output policy, tracking state machine, replay clock,
                    # frame watchdog and treatments (41 tests)
npm run check       # builds TypeScript + native camera, stages it, launches the real Electron app with
                    # Playwright, drives public controls, runs the independent Media Foundation camera
                    # consumer, and writes screenshots + camera frames + summary.json under
                    # evidence/check-<timestamp>/
npm run check:all   # npm test && npm run check
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
independent camera consumer:

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
20. The rigid mask is attached to the tracked face (origin inside the face bounding box, sized to
    it) and the output pixel at its cyan eye plate is the exact mask colour.
21. Mask position and orientation change with the recorded head motion, frame by frame, while the
    mask stays on the face.
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
    origin movement, with screenshots at three points in the turn.

Artifacts are written to the gitignored `evidence/check-<timestamp>/` directory: per-state canvas
screenshots, the full app window, captured output frames, camera-consumer PNGs under
`camera-frames/`, and `summary.json` with the derived base SHA, timing baseline, tracking/model
evidence, hardware, workload, measured boundaries, commands, validation-gate facts and the tested
head SHA.

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
| Camera frames observed | 212 over 6.94 s (30.4 Hz sample rate) |
| Camera frame interval, p95 | 48 ms |
| Replay-to-camera latency, p50 / p95 | 34 ms / 62 ms (canvas capture time → consumer receive time; 32–35 / 55–77 ms across recent runs) |
| Camera mean-RGB spread across the window | 19 (replay content changes across loops) |
| Replay loops crossed during the camera window | 2 |
| Source frame interval, p95 | 55.4 ms in this run; ~42–55 ms across passing runs (the clip presents at ~18–24 Hz here; no 30 FPS forcing) |
| Render + filter cost, p95 | 16.7 ms in this run (main-thread draw/filter plus the diagnostics mean-RGB sample; a connected camera adds canvas readback) |
| Mask render + composite cost, p95 | 11.4 ms (offscreen mask render plus the drawImage composite into the output canvas, including the diagnostics sample) |
| Tracker inference, steady-state p95 | 13.6 ms per presented frame (164 frames) |
| Tracker inference, first-call warm-up | 296.5 ms in this run; ~0.3–2.0 s observed across runs (excluded from the p95) |
| Default-clip mask motion (~2.5 s sample) | origin moved ~7 px horizontally / ~3 px vertically; yaw ~3.5°, pitch ~2.1° (a longer manual sample saw ~12 × 23 px) |
| Recorded motion-window swing (41.6–49.6 s) | yaw 28.8°, pitch 29.1°, roll 18.0°, mask origin 99 × 64 px, 18/18 sampled frames tracked |
| Loop cycles observed | 3 seam crossings inside a 8.27 s sampling window |
| Independent seam validation | 3 backward media-time jumps matched 3 reported seams |
| Replay pacing ratio | 1.004 processing time / wall time in this run |

Replay-derived tracking measurements from the same run are documented in
[`docs/notes/0003-face-tracking-and-mask.md`](docs/notes/0003-face-tracking-and-mask.md). The
default clip's recorded motion is deliberately small (it has no large turns or nods); the
larger-motion CC0 fixture supplies the turn/nod/lean evidence and is used only by the check.

Run-to-run variation is expected under desktop load; these are observations, not benchmarks. The
numbers are replay-derived. They do **not** establish the parent spec's 720p/30 FPS / ≤100 ms
camera-to-output target, physical-camera compatibility, tracking on a physical camera, call-application
compatibility, or laptop integrated-graphics suitability. The camera latency includes the app's ~30 Hz
publish cadence (a frame waits up to one 33 ms sample slot), so p95 is dominated by pacing rather than
transport. The mask is a rigid attachment with no occlusion refinement or secondary motion, and the
policy cannot detect every possible visual defect. See `docs/notes/0001-preview-stack-and-loop.md`,
`docs/notes/0002-windows-virtual-camera-spike.md` and
`docs/notes/0003-face-tracking-and-mask.md`.

## Fixtures

The default input is a CC0-1.0 webcam-style recording of one person facing the camera
(`webcam-loop-v1`). A second CC0 Wikitongues clip (`pose-loop-v1`, 49.6 s, 480p) supplies real head
turns, nods and leaning for the tracking check; the app's default input is unchanged. Their source,
license, attribution, checksums, acquisition commands, content coverage and gaps are documented in
[`docs/fixture-webcam-loop.md`](docs/fixture-webcam-loop.md) and
[`docs/fixture-pose-loop.md`](docs/fixture-pose-loop.md). Media bytes and the face-tracker model are
intentionally not committed; only fetch scripts and metadata are versioned (`tracker/face-landmarker-model.json`).

## Layout

```
src/core/       output policy, tracking state machine, replay clock, canvas pipeline, effects
src/main/       Electron main process, local asset protocol, fixture/tracker validation, IPC,
                virtual camera lifecycle
src/renderer/   desktop preview UI (HTML/CSS/TS), MediaPipe tracker wrapper, Three.js mask renderer,
                and camera frame publication
scripts/        build, start, fixture/model fetch, public-workflow check, native camera scripts
native/         Windows virtual camera: Media Foundation media source, host, consumer harness
tests/          focused unit tests (node:test)
fixtures/       committed fixture manifests; fetched media is gitignored
tracker/        committed Face Landmarker model metadata (source, license, SHA-256); model is gitignored
docs/           fixture notes, preview/loop + virtual camera + tracking notes, ADRs
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
- The check harness accepts `SHYMASK_FIXTURE_DIR`, `SHYMASK_EVIDENCE_DIR`, `SHYMASK_FIXTURE_MANIFEST`
  and `SHYMASK_TRACKER_DIR` to point at different media/evidence/asset directories. The app honors
  the same variables; the checks use them to exercise missing/corrupt fixture and tracker states and
  the larger-motion fixture.

## Scope boundaries

Delivered by this slice: recorded input acquisition and validation, real-time looping, monotonic
processing timestamps, selectable declarative effects (color treatments and a bundled rigid mask),
one-face tracking with readiness/loss hysteresis, the opaque paused-output policy in the preview and
the virtual camera (including tracking loss, multiple faces, unreliable tracking and missing/corrupt
tracker assets), Windows 11 virtual camera publication as `Shymask Camera`, an independent Media
Foundation consumer harness, and reproducible local checks with no physical camera or human
participation. A treatment change is synchronous, so the AC3 async switching-interruption sub-case has
no async state to exercise here and is deliberately deferred to the later effect-package slice.

Deferred: physical webcam capture, live-human acceptance, occlusion refinement (issue #6), secondary
motion, effect packages, real Zoom/Meet/OBS compatibility (issue #10), final live acceptance, NV12
support, the async effect-switching interruption sub-case, laptop integrated-graphics validation, and
the 720p/30 FPS / ≤100 ms target. Two-person footage is not part of this slice; multiple faces are
exercised through a labelled diagnostic injection and the `numFaces: 2` detector configuration.
