# Motion fixture: `pose-loop-v1`

The default replay fixture (`webcam-loop-v1`) has one person but only small head
movement: it was chosen for looping and colour-treatment work, not for tracking
coverage. Issue #4 needs recorded head turns, nods and leaning, so this second
fixture supplies them. It is used **only by the public-workflow check** through
`SHYMASK_FIXTURE_MANIFEST=pose-loop.json`; the app's default input is unchanged.

## Identity

| Field | Value |
| --- | --- |
| Stable identifier | `pose-loop-v1` |
| Local file | `fixtures/cache/pose-loop.webm` (gitignored) |
| Size | 6,058,649 bytes |
| SHA-256 | `f2f53b55b242eec9dea9d72e2705955dd1211377cda18f6db79ed24c8fe71a52` |
| Duration | 49.628 s |
| Video | 854x481, VP9 WebM |
| Audio | Source audio is muted by the preview |

The committed metadata file is [`fixtures/pose-loop.json`](../fixtures/pose-loop.json).

## Source and terms

- Source page: <https://commons.wikimedia.org/wiki/File:Michael_speaking_Esperanto.webm>
- Downloaded file (Wikimedia 480p VP9 transcode):
  <https://upload.wikimedia.org/wikipedia/commons/transcoded/9/9c/Michael_speaking_Esperanto.webm/Michael_speaking_Esperanto.webm.480p.vp9.webm>
- Original upload: 1920x1080 WebM on the same page.
- Author: **Wikitongues, Inc** (Wikimedia Commons)
- License: **CC0 1.0 Universal Public Domain Dedication** -
  <https://creativecommons.org/publicdomain/zero/1.0/>
- Credit line used in this project: "Michael speaking Esperanto" by Wikitongues,
  Inc, Wikimedia Commons, CC0 1.0 (480p VP9 transcode).

CC0 requires no attribution condition; the credit is retained for provenance. The
transcode is pinned rather than the original upload so the checksum is stable and
the download is small.

## Acquisition

```powershell
npm run fetch:motion-fixture            # download and verify; no-op if cached
npm run fetch:motion-fixture -- --force # re-download and re-verify
```

The same script as the default fixture (`scripts/fetch-fixture.mjs`) reads the
manifest, downloads the URL, verifies bytes and SHA-256, and atomically writes the
file. It never commits media.

## Content and coverage

- One seated adult facing the camera throughout, head-and-shoulders framing.
- Natural speaking head movement with several turns, nods, and shifts/leans.
- Single person; the face does not leave the frame in the sampled window.
- Real recorded video (not a synthetic warp); the check seeks to the documented
  window rather than claiming the whole clip is a scripted head-turn sequence.

Measured pose range in the 8 s window starting at **41.6 s** (see
`docs/notes/0003-face-tracking-and-mask.md`): yaw about 25.7 degrees, pitch about
26.4 degrees, roll about 16.1 degrees. That window was selected by scanning the
clip in 0.4 s steps and maximizing the pose spread, then pinned in the check as
`MOTION_WINDOW_START_SECONDS`.

The public check also pins **47.7 s** (`OCCLUSION_CAPTURE_SECONDS`) as a
side-view moment inside that window (yaw about −20° to −22°, measured at the
frozen frame) and **16.0 s** (`OCCLUSION_CAPTURE_SECONDS_OPPOSITE`) as a second
held side view in the opposite yaw direction (about +9° to +14° at the frozen
frame). It holds
each recorded frame and captures occlusion-on/off output PNGs. At the primary
47.7 s view it covers the bundled mask, `guard-visor` and `rose-visor` in the
preview, and the bundled mask and `guard-visor` through the independent
virtual-camera consumer; `rose-visor` has no camera A/B. At the opposite 16.0 s
view it covers the bundled mask and `guard-visor` in the preview and the bundled
mask through the camera. So the A/B covers both turn directions in the preview
(bundled and `guard-visor`) and the imported-mask camera path for `guard-visor`
only.

The same 8 s window supplies the **face-distortion motion evidence** (issue #7):
the imported `face-distortion` package is sampled over the window and its warp
ellipse must move with the tracked face box (see
[`docs/notes/0006-face-distortion.md`](notes/0006-face-distortion.md)). This is
the motion coverage the default clip lacks; it does not imply the distortion
was validated on a physical camera.

The clip also supplies the **secondary-motion settling evidence** (issue #8). A
separate documented window starts at **25.0 s** for 1.9 s: the recorded head turn
around 25.9 s is followed by roughly a second of low head angular velocity. The
imported `reactive-ears` package is sampled there and the reported spring angle
must peak during the turn, keep moving after the head slows, and decay toward
rest (see [`docs/notes/0007-secondary-motion.md`](notes/0007-secondary-motion.md)).
The 41.6 s turn/nod/lean window is still used for the moving-part range evidence.
Neither window proves physical-camera or live-human behavior.

Gaps still relevant to later slices:

- No second person (multiple-face policy uses the labelled diagnostic injection).
- No hand-over-face occlusion, no lighting/camera changes.
- Compressed 480p transcode, not a webcam capture.
- Replay only: not evidence that physical-camera tracking works.

## Verification

```powershell
(Get-FileHash fixtures\cache\pose-loop.webm -Algorithm SHA256).Hash.ToLower()
# f2f53b55b242eec9dea9d72e2705955dd1211377cda18f6db79ed24c8fe71a52
```
