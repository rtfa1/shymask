# Spike note: Windows 11 virtual camera publication

- **Status:** implemented for issue #3. The processed replay canvas (and the exact opaque
  "Tracking paused" screen) is published as the **Shymask Camera** Windows virtual webcam at
  1280×720 / 30 FPS, and an independent Media Foundation consumer process receives it.
- **Date:** 2026-11-13
- **Issue:** [#3 Publish processed replay as a Windows virtual webcam](https://github.com/rtfa1/shymask/issues/3),
  parent spec [#1](https://github.com/rtfa1/shymask/issues/1).
- **Related decisions:** [ADR-0003](../adr/0003-conceal-the-face-on-tracking-failure.md) (opaque
  paused output in every output path), [ADR-0004](../adr/0004-declarative-effect-packages.md).
- **Validated head:** `npm run check` records the exact head SHA, hardware, workload, timing,
  camera evidence and tested commands in `evidence/check-<timestamp>/summary.json`; the matching
  log is `evidence/logs/check-final.log`. Local validation is the gate (no CI in the repository).

## Decision

Use the Windows 11 **Media Foundation software camera source** (`MFCreateVirtualCamera`) rather
than a DirectShow filter. It is the path Windows 11, Teams, browsers and the Camera app enumerate,
and it keeps the virtual camera behind the Media Foundation frame server. A DirectShow filter would
be visible only to DirectShow consumers and would not satisfy "selectable Windows virtual webcam"
for the prototype.

Architecture (all Windows camera code stays under `native/`; the renderer and `src/core` never link
Media Foundation):

```
renderer output canvas (processed frame or opaque "Tracking paused")
        │  getImageData + ipcRenderer.send (main process)
        ▼
Electron main: VirtualCameraPublisher
        │  40-byte header + RGBA over loopback TCP (127.0.0.1:48010–48019, port also written to
        │  %ProgramData%\Shymask\vcam-port)
        ▼
ShymaskVirtualCamera.dll (COM media source, hosted by the Windows frame server)
        │  newest frame -> RGB32 sample, paced at 30 Hz, using the allocator the frame server
        │  provides via IMFSampleAllocatorControl
        ▼
Media Foundation frame server  ──►  Shymask Camera (Windows Virtual Camera)
                                        │
                                        ▼
                            any camera consumer, including the
                            independent shymask-camera-consumer.exe
```

- `native/shymask-vcam/source/` — COM `IMFActivate` + `IMFMediaSourceEx` + one `IMFMediaStream2`
  RGB32 1280×720 stream, CPU sample production, opaque paused fallback for the window before the
  app's first frame.
- `native/shymask-vcam/host/` — `shymask-vcam-host.exe`: registrar (`install`/`uninstall`, `list`)
  and session-lifetime camera owner (`run`). `MFCreateVirtualCamera(SoftwareCameraSource,
  Session, CurrentUser)` + `Start`; `Stop`/`Remove` on stdin `stop` or EOF.
- `native/shymask-vcam/consumer/` — independent Media Foundation consumer: enumerates
  `MFEnumDeviceSources`, activates `Shymask Camera`, reads RGB32 samples through the Source Reader,
  writes PNGs with WIC, reports mean RGB and sample/latency statistics as JSON, and has a hard
  wall-clock watchdog so a stalled stream cannot hang the check.
- `src/main/virtual-camera.ts` — app-side owner: loopback frame server, host supervision, status,
  graceful stop. `src/renderer/renderer.ts` publishes the exact canvas after every drawn output
  frame plus a 100 ms heartbeat (both gated on a connected camera consumer, so an idle camera costs
  no preview render time), so a newly connected consumer can never receive a stale frame from
  before a pause, effect switch or error.

## Registration requirement (learned the hard way)

The media source is an in-proc COM class that the **Windows frame server** (`FrameServer`,
`svchost.exe -k Camera`, `NT AUTHORITY\LocalService`) activates. A per-user (`HKCU`) registration
is therefore not visible to it: `MFCreateVirtualCamera` succeeded and Windows created the per-user
`SWD#VCAMDEVAPI` device, but `IMFVirtualCamera::Start` failed with `0x80070003` and the frame server
logged `FsProxy Initialization Stop … hr: 0x80070003` without ever loading the DLL. The working
requirement is a **machine-wide registration**:

```
HKLM\Software\Classes\CLSID\{5E1D3A6B-2C4F-4A7E-9B8D-0C1F2A3B4C5D}\InprocServer32
    (default)      C:\ProgramData\Shymask\bin\ShymaskVirtualCamera.dll
    ThreadingModel Both
```

This is a one-time elevated action (see Install below). The install also stages the binaries in
`C:\ProgramData\Shymask\bin` (readable by Local Service) and grants the installing user modify
access so later `npm run vcam:install` runs restage the binaries **without** elevation while the
machine-wide registration stays in place.

## Frame delivery: why the first implementation produced no consumer frames

The source was requested 30 samples/s by the frame server but the client received nothing. The
frame server shares the stream with the consumer process, so a virtual camera source must allocate
its samples from the `IMFVideoSampleAllocatorEx` that the frame server provides through
`IMFSampleAllocatorControl`. Plain `MFCreateMemoryBuffer` samples stay in the frame-server process
and never reach the client. The fix:

- implement `IMFSampleAllocatorControl` (`SetDefaultAllocator`, `GetAllocatorUsage` =
  `MFSampleAllocatorUsage_UsesProvidedAllocator`),
- initialize that allocator with the RGB32 media type on stream start and allocate every sample
  from it (with an `IMF2DBuffer::Lock2D` fallback for 2-D buffers and a private allocator only when
  none is provided),
- implement `IMFMediaStream2` (`SetStreamState`/`GetStreamState`),
- use absolute sample timestamps (`MFGetSystemTime()`), matching the working reference
  implementation.

RGB32 flows end to end; NV12 is **not** required for the harness consumer. Offering NV12 remains a
possible compatibility addition for real consumers (see Open questions).

Two harness bugs found during bring-up are fixed: the consumer double-released its Source Reader
at exit (access violation), and the host emitted unescaped backslashes in its JSON `list` output.

## Install / uninstall

```powershell
# once, from an elevated PowerShell prompt (machine-wide registration)
npm run build:native
npm run vcam:install

# afterwards, from a normal shell (restage rebuilt binaries; the HKLM key is untouched)
npm run build:native
npm run vcam:install

# remove the per-user registration (and the machine-wide one if elevated)
npm run vcam:uninstall
```

`npm run vcam:install` stages `ShymaskVirtualCamera.dll`, `shymask-vcam-host.exe` and
`shymask-camera-consumer.exe` in `%ProgramData%\Shymask\bin`, writes the per-user registration, and
writes the machine-wide registration when the shell is elevated. `npm run vcam:status` enumerates
Media Foundation cameras. `npm run vcam:check` runs the native-only workflow (test-pattern source →
host → independent consumer) with a bounded consumer timeout. A loaded media source DLL is moved
aside (`*.stale-<timestamp>`) and replaced on restage; the frame server picks up the new build on
the next activation.

The machine-wide install is the working state for this slice and is intentionally **left in
place**. Uninstall removes the registration; staged binaries and `%ProgramData%\Shymask\vcam.log`
are left for inspection.

## What the checks demonstrate

`npm run check` (35 assertions at the validated head) drives the real app through the public
controls and an independent Media Foundation consumer process:

- `Shymask Camera` is registered and enumerable (`state=publishing enumerable=true`).
- Startup, no effect, manual pause, injected processing failure and a missing replay fixture all
  produce the opaque "Tracking paused" canvas **in the camera consumer** (mean RGB 12,15,20; PNGs
  under `evidence/check-<timestamp>/camera-frames/`).
- Start produces processed replay frames in the consumer that match the preview's treatment
  (warm preview 143,66,41 vs camera 144,67,42 in the validated run; switching to cool changes the
  camera output as well).
- Resume, effect re-selection and failure recovery restore processed camera output automatically.
- The camera consumer receives a continuous stream across at least two replay loops
  (212 frames over 6.75 s, 30.5 Hz) with strictly increasing sample times and visible content
  changes.
- Closing the app stops the camera stream (no frames after close) and removes the device from
  camera enumeration.
- The preview checks (startup/no-effect/manual pause/decode stall/missing and corrupt fixture,
  treatments, loops/seams, pacing, PNG capture, no console errors) and 23 unit tests remain green.

### Measured baseline (replay-based, virtual camera)

From the passing `npm run check` run at the head containing this note (the check summary records
the exact SHA), source clip 3.379 s, Windows 11 Pro 26100, i7-11700K / RTX 3070 Ti / 31.8 GiB,
Electron 45.3.1:

| Measurement | Value |
| --- | --- |
| Camera media type | RGB32 1280×720 @ 30/1 |
| Camera frames observed | 212 over 6.75 s (30.5 Hz sample rate) |
| Camera frame interval, p95 | 48 ms |
| Replay-to-camera latency, p50 / p95 | 31 ms / 54 ms (canvas capture time → consumer receive time) |
| Camera mean-RGB spread across the window | 19 (replay content changes across loops) |
| Replay loops crossed during the camera window | 2 |
| Preview source frame interval, p95 | ~42–49 ms across passing runs (~21–24 Hz replay) |
| Preview render + filter cost, p95 | 0.40 ms without a camera consumer; a connected consumer adds a 1280×720 canvas readback |
| Camera transport | canvas readback → IPC → loopback TCP → RGB32 sample → frame server → consumer |

Boundaries:

- Replay-derived only. There is no camera sensor, call application, or network path, so this does
  **not** establish the parent spec's 720p/30 FPS / ≤100 ms camera-to-output target, physical-camera
  compatibility, or laptop integrated-graphics suitability.
- Latency is measured with both endpoints on the same machine and process tree, using the canvas
  capture wall-clock time carried in a sample attribute. It includes the app's ~30 Hz publish
  cadence (a frame waits up to one 33 ms sample slot), so p95 is dominated by pacing, not transport.
- The consumer is our own Media Foundation Source Reader harness (RGB32). Zoom, Google Meet, OBS,
  the Windows Camera app, and NV12-only consumers are **not** tested here; that is issue #10.
- Face tracking does not exist yet, so the tracking-failure/multiple-face paths are still future
  work; the effect-processing failure injection and decode-stall watchdog are the current failure
  coverage.

## Verification methodology and limits

- The app is the only producer of frames; every check drives it through visible controls
  (Start, Pause/Resume, treatment select, Recheck input, capture, diagnostic failure toggle).
- The camera consumer is a separate process using the public OS camera API
  (`MFEnumDeviceSources` + Source Reader). It writes PNGs and JSON pixel/timing statistics; the
  harness compares camera mean RGB with the preview's diagnostics and asserts the paused screen for
  every paused state.
- The harness bounds every consumer run (consumer-side watchdog plus a Node-side timeout) so a
  stalled camera fails the check instead of hanging.
- Timing numbers come from a single desktop run and vary with load; they are observations, not
  benchmarks.

## Open questions

1. Real consumer compatibility (Windows Camera app, Zoom, Google Meet, OBS) and whether they prefer
   NV12; closing this is the scope of issue #10.
2. Whether a real call application adds latency beyond this replay-based harness measurement.
3. Laptop integrated-graphics behavior, and the final 720p/30 FPS / ≤100 ms budgets, which still
   require tracking/rendering work and a physical camera.
4. Consumer behaviour when the frame server is restarted or the app crashes (session lifetime
   removes the camera; a crash leaves at most the opaque paused fallback until the host exits).
