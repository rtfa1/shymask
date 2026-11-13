# Shymask

Shymask applies visual effects to a webcam feed and (later) publishes the result as a virtual
webcam. This repository is currently a **preview-only technology spike** for issue #2: a desktop
preview loops a recorded webcam-style clip at real-time pacing and displays a selectable color
treatment. No physical webcam, account, cloud service, or live test subject is used.

This slice deliberately does **not** include face tracking, masks, virtual webcam publication, or
the final 720p/30 FPS / 100 ms target. Those arrive in later child tickets of the parent spec.

## Quick start (Windows 11)

Prerequisites: Node.js 22.12+ (tested with 24.19.0) and npm 11+. No Python, ffmpeg, or .NET SDK
is required. Network access is needed for `npm install` and the one-time fixture download.

```powershell
npm install
npm run fetch:fixture   # downloads ~2.7 MB to fixtures/cache and verifies SHA-256
npm start               # builds and opens the desktop preview window
```

The window starts on the opaque "Tracking paused" output. Press **Start** to begin the replay.

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

The app never opens a physical camera in this slice. There is no passthrough mode: the output is
either a processed replay frame or the opaque "Tracking paused" screen.

## What the preview does

- **Recorded input.** `fixtures/cache/webcam-loop.webm` is downloaded by `npm run fetch:fixture` and
  validated against the committed metadata (`fixtures/webcam-loop.json`). Invalid or missing media
  produces an actionable error and hidden output; `Start` stays disabled.
- **One output canvas.** Every frame — processed or paused — is drawn to the single
  `#output` canvas at 1280×720. Later slices will capture that same canvas for the virtual webcam
  and insert tracking before the treatment, instead of building a second demo pipeline.
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

## Checks

```powershell
npm run typecheck   # strict TypeScript across src and tests
npm test            # unit tests for the output policy, replay clock, frame watchdog and treatments (23 tests)
npm run check       # builds, launches the real Electron app with Playwright, drives public controls,
                    # writes screenshots + timing summary under evidence/check-<timestamp>/
npm run check:all   # npm test && npm run check
```

The repository has **no CI** (there is no `.github/workflows` directory) and `main` has **no branch
protection or rulesets** (verified read-only through the GitHub API on 2026-11-13). These local
checks are therefore the validation gate, and they must pass at the exact head SHA being delivered.
The check writes the timing summary, environment, workload and tested head SHA to
`evidence/check-<timestamp>/summary.json`, and refreshes `evidence/logs/check-final.log` for the run
it cites.

The public-workflow check asserts, through the app's visible controls and diagnostics:

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

Artifacts are written to the gitignored `evidence/check-<timestamp>/` directory: per-state canvas
screenshots, the full app window, captured output frames, and `summary.json` with the timing
baseline, hardware, workload, measured boundaries, commands, validation-gate facts and the tested
head SHA.

### Measured baseline (replay-based, preview-only)

From a passing `npm run check` run on 2026-11-13 at head
`46da5873db21a44e9b524cf0f1b739b48aa8edba`, source clip 3.379 s:

- **Hardware:** 11th Gen Intel Core i7-11700K (8 cores / 16 logical), NVIDIA GeForce RTX 3070 Ti,
  31.8 GiB RAM, Windows 11 Pro 10.0.26100 (build 26100). Node.js 24.19.0, Electron 45.3.1.
- **Workload and source mode:** recorded replay fixture `fixtures/cache/webcam-loop.webm` decoded by
  Chromium; Electron development preview only — no physical webcam, call/stream application, or
  virtual webcam in the path.
- **Commands:** `npm run typecheck`, `npm test`, `npm run check`.

| Measurement | Value |
| --- | --- |
| Source frame interval, p95 | 47.4 ms in this run; ~42–49 ms across passing runs (the clip presents at ~21–24 Hz here; no 30 FPS forcing) |
| Render + filter cost, p95 | 0.40 ms (main-thread draw/filter submission; compositor/GPU latency not measured) |
| Loop cycles observed | 3 seam crossings inside a 9.29 s sampling window; that window spans parts of four clip plays (~2.75 clip durations), so it is a cross-seam observation, not a throughput figure |
| Independent seam validation | 3 backward media-time jumps matched 3 reported seams |
| Replay pacing ratio | 0.983 processing time / wall time in this run; ~0.98–0.99 across passing runs |

Run-to-run variation is expected under desktop load; these are observations, not benchmarks. The
numbers are replay-derived. They do **not** establish the parent spec's 720p/30 FPS / ≤100 ms
camera-to-output target, physical-camera compatibility, or laptop integrated-graphics suitability.
See `docs/notes/0001-preview-stack-and-loop.md`.

## Fixture

The clip is a CC0-1.0 webcam-style recording of one person facing the camera. Its source, license,
attribution, checksum, acquisition command, content coverage and gaps are documented in
[`docs/fixture-webcam-loop.md`](docs/fixture-webcam-loop.md). Media bytes are intentionally not
committed; only the fetch script and metadata are versioned.

## Layout

```
src/core/       output policy, replay clock, canvas pipeline, treatments
src/main/       Electron main process, fixture validation, IPC
src/renderer/   desktop preview UI (HTML/CSS/TS)
scripts/        build, start, fixture fetch, public-workflow check
tests/          focused unit tests (node:test)
fixtures/       committed metadata; fetched media is gitignored
docs/           fixture note and the preview/loop spike note
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
- The check harness accepts `SHYMASK_FIXTURE_DIR` and `SHYMASK_EVIDENCE_DIR` to point at a different
  media/evidence directory. The app also honors these variables; the checks use them to exercise
  missing and corrupt fixture states.

## Scope boundaries

Delivered by this slice: recorded input acquisition and validation, real-time looping, monotonic
processing timestamps, a selectable color treatment, the opaque paused-output policy in the preview,
public controls, and reproducible local checks.

Deferred: physical webcam capture, face tracking, masks/occlusion, secondary motion, virtual webcam
publication, Zoom/Meet/OBS compatibility, final live acceptance, and the performance target.
