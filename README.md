# Shymask

Shymask applies visual effects to a webcam feed and publishes the result as a virtual webcam. This
repository currently delivers a **recorded-replay preview** (issue #2) and the **Windows 11 virtual
camera** (issue #3): a desktop preview loops a recorded webcam-style clip at real-time pacing,
displays a selectable color treatment, and publishes the exact same 1280×720 output canvas as
**Shymask Camera** so other applications can select it. No physical webcam, account, cloud service,
or live test subject is used.

Face tracking, masks, effect packages, real call-application compatibility (issue #10), and the
final 720p/30 FPS / 100 ms target are later child tickets of the parent spec.

## Quick start (Windows 11)

Prerequisites: Node.js 22.12+ (tested with 24.19.0) and npm 11+. The Windows virtual camera also
needs the MSVC "Desktop development with C++" workload and the Windows 11 SDK
(`mfvirtualcamera.h`, `mfsensorgroup.lib`), plus a one-time elevated install step. No Python,
ffmpeg, or .NET SDK is required. Network access is needed for `npm install` and the one-time fixture
download.

```powershell
npm install
npm run fetch:fixture   # downloads ~2.7 MB to fixtures/cache and verifies SHA-256
npm run build:native    # ShymaskVirtualCamera.dll, shymask-vcam-host.exe, shymask-camera-consumer.exe

# First time only, from an elevated PowerShell prompt:
npm run vcam:install    # stages binaries + machine-wide (HKLM) camera registration

npm start               # builds and opens the desktop preview window
```

The window starts on the opaque "Tracking paused" output. Press **Start** to begin the replay. The
**Virtual camera** panel shows whether `Shymask Camera` is registered; camera consumers receive the
same frames as the preview. If the camera is not installed, the preview still works and the panel
explains the one-time elevated install.

If `npm install` blocks install scripts (newer npm releases gate them), run
`npm approve-scripts esbuild` and re-run `npm install`.

## Controls

| Control | Behavior |
| --- | --- |
| **Start** | Begins real-time playback of the fixture already validated at launch. Disabled while the fixture is missing, corrupt, or playback has already started. |
| **Pause / Resume** | Manual pause replaces the whole output with the opaque "Tracking paused" screen and freezes processing. It persists until Resume is pressed. |
| **Color treatment** | `Warm tint`, `Cool tint`, `Monochrome`, or explicit `No effect`. Choosing `No effect` hides the output; choosing a treatment restores it automatically. |
| **Recheck input** | Re-runs fixture size/checksum validation. Use after fetching a fixture that was missing at launch. |
| **Capture evidence frame** | Writes the current output canvas (1280×720 PNG) to `evidence/` and shows the path in the app. |
| **Simulate effect-processing failure** | Diagnostic-only toggle that forces the failure policy to demonstrate the opaque paused output and automatic recovery. |
| **Restart virtual camera** | Re-runs the native camera host (for example after an elevated install or a camera error). |

The app never opens a physical camera in this slice. There is no passthrough mode: the output is
either a processed replay frame or the opaque "Tracking paused" screen, in the preview **and** in
the virtual camera. Closing Shymask stops its camera output.

## What the output path does

- **Recorded input.** `fixtures/cache/webcam-loop.webm` is downloaded by `npm run fetch:fixture` and
  validated against the committed metadata (`fixtures/webcam-loop.json`). Invalid or missing media
  produces an actionable error and hidden output; `Start` stays disabled.
- **One output canvas.** Every frame — processed or paused — is drawn to the single `#output`
  canvas at 1280×720. That same canvas is what the virtual camera publishes; there is no second
  pipeline and no separate camera state machine.
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
- **Failure policy.** The policy in `src/core/output-policy.ts` returns the opaque
  "Tracking paused" decision for startup, first-frame wait, missing/invalid fixture, no active
  effect, manual pause, and effect-processing failure. It has no raw-passthrough branch.
- **Declarative treatments.** Color treatments are data (`src/core/treatments.ts`): a label and a
  canvas filter expression. No executable effect code is loaded.
- **Virtual camera publication.** While the app runs, `src/main/virtual-camera.ts` serves the output
  canvas to the native Windows virtual camera over a loopback frame transport, and
  `src/renderer/renderer.ts` pushes every drawn output frame plus a 100 ms heartbeat (only while a
  camera consumer is connected). Startup, no effect, manual pause, processing errors, missing input
  and effect switches therefore all appear in the camera as the exact opaque "Tracking paused"
  canvas. The camera uses `MFVirtualCameraLifetime_Session`, so closing Shymask stops the stream and
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
reach a consumer process. NV12 and real call applications are not implemented here; that is issue
#10. See [`docs/notes/0002-windows-virtual-camera-spike.md`](docs/notes/0002-windows-virtual-camera-spike.md)
for the architecture, the registration failure that was investigated, and the measured results.

## Checks

```powershell
npm run typecheck   # strict TypeScript across src and tests
npm test            # unit tests for the output policy, replay clock, frame watchdog and treatments (23 tests)
npm run check       # builds TypeScript + native camera, stages it, launches the real Electron app with
                    # Playwright, drives public controls, runs the independent Media Foundation camera
                    # consumer, and writes screenshots + camera frames + summary.json under
                    # evidence/check-<timestamp>/
npm run check:all   # npm test && npm run check
```

`npm run check` requires the native camera prerequisites (MSVC + Windows 11 SDK) and the
machine-wide registration from the one-time elevated `npm run vcam:install`. It builds and restages
the native components so the tested binaries match the committed sources.

The public-workflow check asserts, through the app's visible controls, its diagnostics and the
independent camera consumer:

1. Startup is the opaque "Tracking paused" screen; no raw feed.
2. Start renders a processed replay frame through the treatment control.
3. Warm, cool and monochrome treatments visibly change the output (measured as mean RGB of the
   output canvas); monochrome is near-neutral.
4. `No effect` returns to the opaque paused screen, and selecting a treatment restores output.
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
    deliver the opaque "Tracking paused" canvas to the camera consumer (mean RGB ≈ 12,15,20, with
    PNG evidence).
15. Processed replay frames in the camera match the preview's treatment (warm, cool), effect
    switches and pause/resume change the camera output, and recovery is automatic.
16. The camera receives a continuous 30 FPS sample stream across multiple replay loops.
17. A replay-based replay-to-camera latency baseline is recorded.
18. Closing the app stops camera frames and removes the camera from device enumeration.

Artifacts are written to the gitignored `evidence/check-<timestamp>/` directory: per-state canvas
screenshots, the full app window, captured output frames, camera-consumer PNGs under
`camera-frames/`, and `summary.json` with the timing baseline, camera evidence, hardware, workload,
measured boundaries, commands, validation-gate facts and the tested head SHA.

### Measured baseline (replay-based, virtual camera)

From a passing `npm run check` run on 2026-11-13 (the check summary records the exact head SHA),
source clip 3.379 s:

- **Hardware:** 11th Gen Intel Core i7-11700K (8 cores / 16 logical), NVIDIA GeForce RTX 3070 Ti,
  31.8 GiB RAM, Windows 11 Pro 10.0.26100 (build 26100). Node.js 24.19.0, Electron 45.3.1.
- **Workload and source mode:** recorded replay fixture `fixtures/cache/webcam-loop.webm` decoded by
  Chromium; Electron preview publishing its output canvas as the `Shymask Camera` virtual webcam; an
  independent Media Foundation Source Reader process consumes the camera. No physical webcam or call
  application is in the path.
- **Commands:** `npm run typecheck`, `npm test`, `npm run check`.

| Measurement | Value |
| --- | --- |
| Camera media type | RGB32 1280×720 @ 30/1 |
| Camera frames observed | 212 over 6.68 s (30.4 Hz sample rate) |
| Camera frame interval, p95 | 47 ms |
| Replay-to-camera latency, p50 / p95 | 32 ms / 56 ms (canvas capture time → consumer receive time) |
| Camera mean-RGB spread across the window | 19 (replay content changes across loops) |
| Replay loops crossed during the camera window | 2 |
| Source frame interval, p95 | 42 ms in this run; ~42–49 ms across passing runs (the clip presents at ~21–24 Hz here; no 30 FPS forcing) |
| Render + filter cost, p95 | 0.40 ms (main-thread draw/filter submission with no camera consumer; a connected camera adds canvas readback) |
| Loop cycles observed | 3 seam crossings inside a 9.29 s sampling window |
| Independent seam validation | 3 backward media-time jumps matched 3 reported seams |
| Replay pacing ratio | 0.979 processing time / wall time in this run |

Run-to-run variation is expected under desktop load; these are observations, not benchmarks. The
numbers are replay-derived. They do **not** establish the parent spec's 720p/30 FPS / ≤100 ms
camera-to-output target, physical-camera compatibility, call-application compatibility, or laptop
integrated-graphics suitability. The camera latency includes the app's ~30 Hz publish cadence (a
frame waits up to one 33 ms sample slot), so p95 is dominated by pacing rather than transport. See
`docs/notes/0001-preview-stack-and-loop.md` and
`docs/notes/0002-windows-virtual-camera-spike.md`.

## Fixture

The clip is a CC0-1.0 webcam-style recording of one person facing the camera. Its source, license,
attribution, checksum, acquisition command, content coverage and gaps are documented in
[`docs/fixture-webcam-loop.md`](docs/fixture-webcam-loop.md). Media bytes are intentionally not
committed; only the fetch script and metadata are versioned.

## Layout

```
src/core/       output policy, replay clock, canvas pipeline, treatments
src/main/       Electron main process, fixture validation, IPC, virtual camera lifecycle
src/renderer/   desktop preview UI (HTML/CSS/TS) and camera frame publication
scripts/        build, start, fixture fetch, public-workflow check, native camera scripts
native/         Windows virtual camera: Media Foundation media source, host, consumer harness
tests/          focused unit tests (node:test)
fixtures/       committed metadata; fetched media is gitignored
docs/           fixture note and the preview/loop + virtual camera notes
```

## Environment notes and troubleshooting

- Runtime is entirely local: no account, telemetry, or cloud calls. The fixture fetch is the only
  runtime-time network use, and it happens before the app starts.
- If Electron exits immediately under a shell that exports `ELECTRON_RUN_AS_NODE=1`, `npm start`
  strips that variable for the child process. Use `npm start` rather than invoking `electron`
  directly in such an environment.
- **Missing fixture:** the status area names the expected path and `npm run fetch:fixture`; fetch it
  and press **Recheck input**.
- **Checksum or size mismatch:** delete `fixtures/cache/webcam-loop.webm`, re-run
  `npm run fetch:fixture`, then press **Recheck input**. Do not edit the committed checksum without
  reviewing the upstream source.
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
  oracle; a stalled consumer now times out with JSON instead of hanging.
- The check harness accepts `SHYMASK_FIXTURE_DIR` and `SHYMASK_EVIDENCE_DIR` to point at a different
  media/evidence directory. The app also honors these variables; the checks use them to exercise
  missing and corrupt fixture states.

## Scope boundaries

Delivered by this slice: recorded input acquisition and validation, real-time looping, monotonic
processing timestamps, selectable color treatments, the opaque paused-output policy in the preview
and the virtual camera, Windows 11 virtual camera publication as `Shymask Camera`, an independent
Media Foundation consumer harness, and reproducible local checks with a replay-based timing
baseline.

Deferred: physical webcam capture, face tracking, masks/occlusion, secondary motion, effect
packages, real Zoom/Meet/OBS compatibility (issue #10), final live acceptance, NV12 support, laptop
integrated-graphics validation, and the 720p/30 FPS / ≤100 ms target.
