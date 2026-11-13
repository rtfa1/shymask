# Spike note: preview stack, replay loop and output path

- **Status:** implemented for issue #2; preview only. Superseded behavior for tracking, effects and
  virtual webcam comes from later child tickets of spec #1.
- **Date:** 2026-11-13
- **Head:** the commit containing this note (the check summary records the exact SHA).
- **Validated head:** `46da5873db21a44e9b524cf0f1b739b48aa8edba` — `npm run typecheck`, `npm test`
  and `npm run check` passed at that head. This note's commit changes documentation only; the final
  re-validation at the documentation head is recorded in `evidence/logs/check-final.log` and the
  matching `evidence/check-<timestamp>/summary.json`.
- **Related decisions:** [ADR-0003](../adr/0003-conceal-the-face-on-tracking-failure.md) (paused
  output), [ADR-0004](../adr/0004-declarative-effect-packages.md) (declarative effects). No ADR is
  modified or contradicted by this note.

## Decision

Use **Electron 45 + strict TypeScript** with a plain HTML/CSS renderer and a single 1280×720
`<canvas>` output. The renderer is bundled with esbuild; the main process and unit tests are
compiled with `tsc`. The desktop window is the only preview surface, and Playwright's Electron
driver launches the real app for public-workflow checks.

Input: a CC0-1.0 recorded WebM clip fetched on demand
([fixture note](../fixture-webcam-loop.md)), decoded by Chromium's bundled media stack.

Why this stack here:

- The environment has Windows 11, Node.js and npm, but no Python, ffmpeg, or .NET SDK. Electron is
  installable from npm and needs no additional runtime.
- Chromium decodes WebM without a separate media toolchain and provides
  `requestVideoFrameCallback` for present-time frame scheduling and media timestamps.
- A canvas is a practical future source for both the preview and a virtual camera
  (`canvas.captureStream()` / frame handoff), so the spike does not create a disposable second
  pipeline for later slices.
- It leaves native work (Windows virtual-camera registration) as a later, isolated problem rather
  than coupling the preview to an SDK that is not installed.

Alternatives considered: a native C#/WinUI prototype (no .NET SDK available, slower to prove),
a browser-only page (no desktop window or later virtual-camera path), and a game-engine renderer
(heavy for a color-treatment/infra spike). None were rejected on principle; Electron was the
smallest stack that could be installed and demonstrated here.

## Data flow

```
recorded WebM (validated in main)          later: physical camera adapter
            │                                        │
            └──────────────┬─────────────────────────┘
                           ▼
                 replay clock / frame source
            (requestVideoFrameCallback + monotonic time)
                           ▼
                 output policy (pure state machine)
            ┌──────────────┴───────────────┐
            ▼                              ▼
   processed frame                 opaque "Tracking paused"
   (declarative color filter)      (same canvas path)
            └──────────────┬───────────────┘
                           ▼
                 single 1280×720 output canvas
                  (preview now, virtual webcam later)
```

- `src/main/fixture.ts` validates the metadata, file size and SHA-256 before any frame is exposed.
  Startup and **Recheck input** both re-run it; the renderer also checks the decoded duration.
- `src/core/replay-clock.ts` produces loop-aware processing timestamps. `loopIndex` increments on a
  backward media-time jump larger than 250 ms (a loop seam). The timestamp is
  `loopIndex × clipDuration + mediaTime`, so it keeps increasing across seams. Wall-clock presented
  time is recorded for frame pacing diagnostics. Invalid or non-increasing timestamps hide output
  instead of presenting untimed frames.
- `src/core/output-policy.ts` is the only decision point for visible output: processed frame or
  opaque paused screen. It covers startup, first-frame wait, missing/invalid fixture, no effect,
  manual pause and processing failure. It has no raw passthrough branch.
- `src/core/pipeline.ts` is the only renderer of output frames. Processed frames and the paused
  screen are both drawn on the same canvas; later tracking can be inserted before the treatment and
  later webcam publication can consume the same canvas.
- `src/core/treatments.ts` holds color treatments as data (label plus canvas filter expression),
  consistent with the declarative-effect direction in ADR-0004.

## Loop seam behavior

The clip loops with `video.loop = true`. Chromium resets `currentTime`/`mediaTime` at each seam and
can briefly report `readyState < 2` for the first frame after the reset. The implementation:

- reports each reset as one deliberate **loop seam** in the diagnostics;
- keeps the last processed frame visible during a one-frame decode gap instead of flashing the
  paused screen (which would incorrectly look like a tracking/effect failure);
- treats a decode gap longer than 250 ms as a processing failure, hiding the output until a valid
  frame returns;
- runs a 50 ms timer watchdog (`src/core/frame-watchdog.ts`) for the stall that
  `requestVideoFrameCallback` cannot report: when the decoder stops presenting frames entirely, the
  watchdog compares `performance.now()` with the last presented frame and, after 250 ms while
  started, unpaused and an effect is active, renders the opaque paused screen. The next valid frame
  clears the stall and restores the treatment automatically. The watchdog is armed on Start and
  Resume and disarmed on manual pause, Recheck input and input disposal, so no stale baseline can
  hide a healthy preview;
- does not reinterpret the seam as a tracking discontinuity; tracking does not exist in this slice.

The clip's end and start frames are not guaranteed to match, so a visible cut at the seam is
possible. That cut is a property of the recorded loop, not a tracking defect.

## Measured baseline (replay-based, preview-only)

Passing `npm run check` run at head `46da5873db21a44e9b524cf0f1b739b48aa8edba` on 2026-11-13,
source clip 3.379 s.

**Hardware:** 11th Gen Intel Core i7-11700K (8 cores / 16 logical), NVIDIA GeForce RTX 3070 Ti,
31.8 GiB RAM, Windows 11 Pro 10.0.26100 (build 26100). Node.js 24.19.0, Electron 45.3.1.

**Workload and source mode:** recorded replay fixture `fixtures/cache/webcam-loop.webm` decoded by
Chromium's bundled media stack, driven through the Electron development preview only. No physical
webcam is opened, no call or stream application runs, and no virtual webcam is published in this
slice. The display is a 1280×720 canvas upscaled into the app window.

**Exact commands:** `npm run typecheck`, `npm test`, `npm run check` (optionally `npm run check:all`).
Results and the tested head SHA are written to `evidence/logs/` and
`evidence/check-<timestamp>/summary.json`.

| Measurement | Value |
| --- | --- |
| Source frame interval, p95 | 47.4 ms in this run; ~42–49 ms across passing runs (~21–24 Hz presentation; 30 FPS is not forced) |
| Render + filter cost, p95 | 0.40 ms main-thread draw/filter submission |
| Loops observed | 3 seam crossings in a 9.29 s sampling window |
| Independent seam validation | 3 backward media-time jumps matched 3 reported seams |
| Pacing ratio | 0.983 processing time / wall time in this run; ~0.98–0.99 across passing runs |
| Output | 1280×720 canvas; PNG capture verified at that resolution |

The "3 loops in ~9.3 s" shorthand needs care: it counts three **seam crossings inside a 9.29 s
sampling window**. Because the window starts mid-play and spans parts of four clip plays
(~2.75 clip durations), it is not a claim that three full loops finish in 9.3 s; the clip duration
and pacing ratio above are the meaningful figures.

Run-to-run variation is expected under desktop load; these are observations from passing runs, not
benchmarks. Caveats that matter:

- These are **replay-derived** measurements. They say nothing about camera-sensor-to-output latency
  or physical-camera compatibility.
- Render cost measures the renderer's draw/filter submission, not compositor/GPU/present latency or
  end-to-end delay. No 100 ms claim is made.
- Measured on one desktop; laptop integrated-graphics behavior is unverified.
- Preview only: no virtual webcam consumer, tracking, or secondary motion is in the frame path yet.

## Verification methodology and limits

`npm run check` launches the Electron app through Playwright, uses only visible controls
(Start, Pause/Resume, treatment select, Recheck input, Capture evidence frame, diagnostic failure
toggle) and reads visible status/diagnostic text plus canvas screenshots. One deliberate failure
injection beyond the visible controls pauses the media element directly to simulate a silent decode
stall without setting the manual-pause state; it is marked as injection in the harness. The check
verifies:

- exact opaque "Tracking paused" output for startup, no effect, manual pause, simulated processing
  failure, a silent decode stall, missing fixture and checksum-corrupt fixture;
- the raw replay feed is hidden in those states (mean RGB of the output canvas is the dark paused
  screen, and no `<video>` element is created when the fixture is missing);
- treatments visibly change output and monochrome is near-neutral;
- multiple loop cycles with strictly increasing processing timestamps and near real-time pacing,
  where reported seams are cross-checked against independent backward media-time jumps in the
  sampled diagnostics;
- a silent decode stall shows the paused screen after the 250 ms watchdog and recovers on the next
  frame;
- Recheck after the diagnostic failure toggle clears the injected failure and recovers the
  processed preview on Start; a second, different corrupt fixture replaces the stale explanation;
- the public capture control produces a 1280×720 PNG;
- no renderer console errors and no physical-camera API in application source.

The repository has no CI configuration (no `.github/workflows`) and `main` has no branch protection
or rulesets (verified read-only via the GitHub API on 2026-11-13). Local validation is therefore the
gate, and it must pass at the exact head SHA being delivered; the check summary records the head,
hardware, workload, measured boundaries, commands and these gate facts.

Limits: RGB/mean-color assertions are coarse and not visual-quality judgments; screenshot evidence
is from a desktop session, not a headless CI environment; the fixture is short and has limited
motion coverage; there is no test of a physical camera, a real person, laptop hardware, or any
virtual-webcam consumer. These are explicit gaps, not passes.

## Unresolved feasibility questions

1. **Windows virtual camera path.** Electron does not provide a virtual camera. Options (Media
   Foundation virtual camera with a registered COM component, a DirectShow source, or a helper
   process with a native addon) need a spike covering packaging, registration, and per-app
   compatibility (Zoom, Meet, OBS). This is the largest unresolved risk for the prototype.
2. **Frame handoff cost and latency.** How to move 1280×720 frames from the renderer to the native
   virtual camera without extra copies or stalls, and how that composes with tracking, is unproven.
3. **Performance headroom.** The ~0.4 ms draw/filter submission leaves room in this preview, but
   compositor latency, tracking cost (for example MediaPipe/WASM/GPU), and the 100 ms end-to-end
   budget are unmeasured. No performance target is claimed.
4. **Effect representation.** Canvas CSS filters are sufficient for this spike's color treatments,
   but the eventual effect package needs a runtime representation that also covers masks,
   distortion, occlusion and secondary motion under ADR-0004's schema decision.
5. **Input abstraction for a camera.** The replay source is a `<video>` element; a physical camera
   will use `getUserMedia`/`MediaStreamTrackProcessor`. The shared timing/policy boundary is in
   place, but the adapter's permission/error handling and device loss behavior are unimplemented.
6. **Laptop and call-app behavior.** Integrated-graphics laptops, backgrounded windows, and a real
   call application consuming the virtual camera remain unverified.
