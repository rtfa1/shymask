# Spike note: Windows 11 virtual camera publication

- **Status:** blocked on a Windows permission boundary. The native virtual camera spike is
  implemented and the per-user parts are verified, but no camera can be published or consumed by
  a standard account because Media Foundation's frame server cannot activate a per-user
  (HKCU) COM media source. The Electron app is deliberately **not** wired to the camera yet;
  doing so would add unverifiable code on top of a blocked path.
- **Date:** 2026-11-13
- **Issue:** [#3 Publish processed replay as a Windows virtual webcam](https://github.com/rtfa1/shymask/issues/3),
  parent spec [#1](https://github.com/rtfa1/shymask/issues/1).
- **Related decisions:** [ADR-0003](../adr/0003-conceal-the-face-on-tracking-failure.md) (opaque
  paused output in every output path), [ADR-0004](../adr/0004-declarative-effect-packages.md).
- **Validated head:** the check records the exact head SHA it ran at in
  `evidence/vcam-check/summary.json`; `evidence/logs/vcam-final.log` holds the matching log.
  The committed sources are the spike described here.

## What was built

A native Windows component set under `native/shymask-vcam/`, kept outside the renderer and the
portable processing core:

| Component | Purpose |
| --- | --- |
| `ShymaskVirtualCamera.dll` | In-proc COM media source (`IMFActivate` + `IMFMediaSourceEx` + one RGB32 1280×720 stream) that serves frames from a loopback TCP transport. |
| `shymask-vcam-host.exe` | Registrar and camera-lifetime owner: `MFCreateVirtualCamera(SoftwareCameraSource, Session, CurrentUser)` + `Start`, kept alive for the app session, `Stop`/`Remove` on shutdown. Also owns install/uninstall/enumeration. |
| `shymask-camera-consumer.exe` | Independent Media Foundation camera consumer: enumerates `MFEnumDeviceSources`, activates `Shymask Camera`, reads RGB32 samples through the Source Reader, writes PNGs with WIC, and reports pixel/timing statistics as JSON. |

Supporting pieces:

- `native/shymask-vcam/protocol.h` — CLSID, wire format (40-byte header + RGBA payload), port
  discovery (`%ProgramData%\Shymask\vcam-port`, fallback range 48010–48019), and the per-sample
  attribute carrying the canvas capture time for latency measurement.
- `native/shymask-vcam/source/frame-transport.cpp` — the only bridge between the portable frame
  producer and the camera. The renderer/pipeline never touches Media Foundation; a future macOS
  adapter can replace this transport without changing the output policy or the canvas.
- `native/shymask-vcam/source/paused-frame.cpp` — opaque "Tracking paused" fallback used before the
  app's first frame arrives (the app sends its own paused canvas through the same transport for
  every policy-paused state, so the consumer always receives the exact preview output).
- `scripts/build-native.mjs` — MSVC/Windows SDK build (no admin needed).
- `scripts/vcam.mjs` — stages binaries in `%ProgramData%\Shymask\bin`, registers per user, and
  (when elevated) machine-wide; `uninstall` reverses both.
- `scripts/vcam-check.mjs` — repeating workflow check with a 1280×720 test-pattern frame source. If
  the camera starts it asserts consumer frames and pixels; if it cannot start it records an
  explicit BLOCKED report with HRESULTs, registry state, frame-server events and the unblock.
- `scripts/dev/vcam-test-pattern.mjs` — development-only frame source for the native path.

## What works (verified on this machine)

Environment: Windows 11 Pro 10.0.26100 (build 26100), standard user `windows11\rodri` (not
elevated), Node.js 24.19.0, MSVC 14.50 / Windows SDK 10.0.26100.

1. `npm run build:native` compiles all three binaries with `cl.exe` (no admin).
2. `npm run vcam:install` stages the binaries into `%ProgramData%\Shymask\bin`, grants Local
   Service / Local System access to `%ProgramData%\Shymask`, and writes
   `HKCU\Software\Classes\CLSID\{5E1D3A6B-2C4F-4A7E-9B8D-0C1F2A3B4C5D}\InprocServer32`
   (default value = staged DLL, `ThreadingModel=Both`).
3. `MFCreateVirtualCamera(MFVirtualCameraType_SoftwareCameraSource,
   MFVirtualCameraLifetime_Session, MFVirtualCameraAccess_CurrentUser, L"Shymask Camera",
   L"{5E1D3A6B-...}", nullptr, 0)` returns `S_OK` (`0x00000000`) for the standard user. The camera
   privacy store is set to `Allow`; no `E_ACCESSDENIED` from privacy control was observed.
4. During `Start` the OS activates the registered media source **in the requesting process**:
   `DllMain` → `DllGetClassObject` → `Activator::ActivateObject` → media source initialization all
   succeed (`%ProgramData%\Shymask\vcam.log`), and the OS reads the presentation descriptor, source
   attributes and stream attributes. The media source and its 1280×720 RGB32 stream descriptor are
   accepted.
5. The OS creates a per-user software device; the frame server log records the matching symbolic
   link (for example
   `\\?\SWD#VCAMDEVAPI#0EDA1A3B...#{e5323777-f976-4f5b-9b55-b94699c46e44}\{FCEBBA03-...}`).

## Where it stops (verified)

`IMFVirtualCamera::Start` returns **`0x80070003`** (ERROR_PATH_NOT_FOUND, "The system cannot find
the path specified.") for the standard user. Immediately before the failure the frame server logs:

```
Microsoft-Windows-MF-FrameServer/Camera_FrameServer, event 7:
FrameServer FsProxy Initialization Stop, SymbolicLink: \\?\SWD#VCAMDEVAPI#...#{...},
Devices: 1, Streams: 0, StreamType: SHARED, hr: 0x80070003.
```

The frame server (service `FrameServer`, `svchost.exe -k Camera`, `NT AUTHORITY\LocalService`)
is the process that must instantiate the camera media source. It never loads
`ShymaskVirtualCamera.dll`: `vcam.log` contains no `DllMain`/`ActivateObject` entry from the
frame server PID, only from `shymask-vcam-host.exe`. Per-user COM registration
(`HKCU\Software\Classes`) is not visible to the Local Service account, and the frame server has no
per-user fallback for a session/per-user camera.

Confirming the permission boundary:

- `reg add "HKLM\Software\Classes\CLSID\{5E1D3A6B-...}\InprocServer32" ...` → `ERROR: Access is
  denied.` The standard account cannot create machine-wide registrations.
- `IMFVirtualCamera::AddRegistryEntry`, the documented per-camera registry API, requires
  administrator permissions by documentation (and is not available to UWP/packaged apps).
- The camera is not enumerable after the failed start (`enumerationAfterFailedStart: []`), so no
  consumer ever receives a frame. No consumer evidence is claimed.

This matches the documented behaviour of third-party virtual camera samples: the media source COM
class must be registered in `HKLM` because the frame server loads it (see the
[VCamSample README](https://github.com/smourier/VCamSample) and
[VCamNetSample README](https://github.com/smourier/VCamNetSample), which state that
`regsvr32` must run as administrator and that a virtual camera media source cannot be registered in
`HKCU`).

## Evidence

- `npm run vcam:check` writes `evidence/vcam-check/summary.json`, plus
  `evidence/vcam-check/frame-server-events.txt`, `evidence/vcam-check/vcam.log` and
  `evidence/logs/vcam-final.log`. The summary records the tested head SHA, environment, registry
  state, enumeration after the failed start, the frame-server events, findings and the unblock.
  Exit code `3` means the camera could not be started; `0` means the consumer path passed.
- `npm run vcam:status` enumerates Media Foundation video capture devices through the same public
  path the consumer uses.
- No `evidence/vcam-check/frames/` PNG exists in this run because no frames were delivered. That
  absence is part of the blocker evidence, not a pass.

## Smallest unblock

One elevated action, then the same commands work unchanged:

```powershell
# In an elevated PowerShell prompt, once:
cd <worktree>
npm run vcam:install
```

The elevated run stages the same binaries and additionally writes
`HKLM\Software\Classes\CLSID\{5E1D3A6B-2C4F-4A7E-9B8D-0C1F2A3B4C5D}\InprocServer32` pointing at
`C:\ProgramData\Shymask\bin\ShymaskVirtualCamera.dll`, which the Local Service frame server can
read. `npm run vcam:uninstall` from an elevated prompt removes the machine registration; the
per-user registration is removed without elevation.

After that, `npm run vcam:check` should enumerate `Shymask Camera Windows Virtual Camera`, start the
camera, and let the independent consumer capture frames. Only then should the Electron app be wired
to this path: the remaining work is to spawn the host, push the existing output canvas through the
same TCP protocol, surface the camera status in the app, and extend `npm run check` with the
consumer assertions required by issue #3 (paused screen, multiple loops, pause/resume, missing
fixture, injected failure, close-stops-output, 720p/30 timing baseline).

## Technology decisions

- **Media Foundation software camera source**, not DirectShow: this is the Windows 11 camera path
  and the one the acceptance criteria target. A DirectShow source filter would be enumerable only
  in DirectShow consumers (it is not what Windows 11 Settings, Teams or browsers enumerate) and
  would not satisfy "selectable Windows virtual webcam" for the prototype.
- **TCP loopback + a 40-byte header + RGBA payload** for the frame transport: the app owns the
  single output canvas; the media source maps the newest frame to an RGB32 sample (RGBA→BGRA
  conversion in the native layer). This keeps `src/core` and the renderer free of Windows APIs and
  gives a future macOS integration a small interface to replace.
- **`MFVirtualCameraLifetime_Session`** and a host process that owns the `IMFVirtualCamera`: closing
  Shymask (or the host) stops and removes the camera. `MFVirtualCameraLifetime_System` is not used
  so no persistent camera is left behind by tests.
- **CPU-only sample production** (memory buffers, no D3D manager): the app already produces CPU
  canvas frames, so a GPU path would add copies without removing the RGBA→RGB32 conversion in this
  slice.
- **Frames are pull-driven and paced at 30 Hz** by the media source; when the app is not connected
  the opaque "Tracking paused" fallback is delivered, never transparent or stale raw frames.

## Unresolved questions (for the unblocked slice)

1. Will the frame server accept the source once it is registered in HKLM, or are further
   requirements (for example a packaged identity or `AddRegistryEntry` values) needed? The spike
   cannot test this without the elevated step.
2. Real consumers (Windows Camera app, Zoom/Meet/OBS) and their preferred formats are untested; the
   consumer harness requests RGB32. Offer NV12 as well if a real consumer refuses RGB32.
3. Replay-to-camera timing at 720p/30 is unmeasured because no frames flowed; the transport and
   sample path are ready to measure once the camera starts.
4. Whether a signed MSIX/sparse package can provide the machine-visible registration without admin
   (and whether that is acceptable for an unpackaged Electron app) remains open.
