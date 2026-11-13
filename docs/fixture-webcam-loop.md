# Replay fixture: `webcam-loop-v1`

The preview's default input is a recorded webcam-style clip, not a physical camera. The media is
fetched on demand and never committed. This note records its source, terms, acquisition, checksum
and content coverage.

## Identity

| Field | Value |
| --- | --- |
| Stable identifier | `webcam-loop-v1` |
| Local file | `fixtures/cache/webcam-loop.webm` (gitignored) |
| Size | 2,823,374 bytes |
| SHA-256 | `81a22d3519fddc8dc6be30c8cc46525f09eca77817ccdcbf2311a45ae18ebeab` |
| Duration | 3.379 s |
| Video | 1920×1080, WebM |
| Audio | Any source audio is muted by the preview |

The committed metadata file is [`fixtures/webcam-loop.json`](../fixtures/webcam-loop.json); it is
the single source of truth for the filename, byte count, checksum and documented duration.

## Source and terms

- Source page: <https://commons.wikimedia.org/wiki/File:Tanzanian_Sign_Language_-_Habari_ya_asubuhi_(Good_Morning)_-_greeting_02.webm>
- Original file URL: <https://upload.wikimedia.org/wikipedia/commons/c/cb/Tanzanian_Sign_Language_-_Habari_ya_asubuhi_%28Good_Morning%29_-_greeting_02.webm>
- Author: **Rwebogora** (Wikimedia Commons)
- Published: 2024-09-29
- License: **CC0 1.0 Universal Public Domain Dedication** —
  <https://creativecommons.org/publicdomain/zero/1.0/>
- Credit line used in this project: "Tanzanian Sign Language - Habari ya asubuhi (Good Morning) -
  greeting 02" by Rwebogora, Wikimedia Commons, CC0 1.0.

CC0 requires no attribution condition; the credit is retained for provenance. The clip is not
modified by the fetch step (the exact upstream file is stored). The upstream page also offers
Wikimedia transcodes; this project pins the original upload so the checksum is stable.

## Repeatable acquisition

```powershell
npm run fetch:fixture            # download and verify; no-op if the cached file is valid
npm run fetch:fixture -- --force # re-download and re-verify
```

`scripts/fetch-fixture.mjs`:

1. Reads `fixtures/webcam-loop.json`.
2. Downloads `originalUrl` with a descriptive `User-Agent`; retries HTTP 429/5xx with backoff.
3. Rejects a download whose byte count or SHA-256 differs from the metadata (removing the partial
   file), and prints the source, license, expected and actual values plus a recovery instruction.
4. Atomically replaces `fixtures/cache/webcam-loop.webm` only after verification.

The fetch uses only Node's built-in `fetch`/`crypto`; no Python, ffmpeg, or extra downloader is
needed. Wikimedia can serve rate limits to shared IPs, so the script includes retries; a persistent
failure is reported rather than silently accepted.

If upstream ever replaces the original file, the checksum check fails. Update the metadata only
after reviewing the new source and license; never bypass the checksum to make the app start.

## Content and coverage

Suitable properties for this slice:

- One person facing the camera in a head-and-shoulders webcam-style framing.
- Visible facial expression and hand signs, with small head movement.
- Short enough to complete several real-time loop cycles in a check run.
- Permissively licensed, downloadable without an account, and directly decodable by Electron's
  bundled Chromium (WebM).

Known coverage gaps, relevant to later tracking and effect slices:

- No large head turns, pronounced nods, or leaning out of frame.
- No hand-over-face occlusion, no second person, and no face leaving/re-entering the frame.
- No lighting change, camera motion, or background change.
- No full-body movement; the framing is seated head-and-shoulders.
- This is replay-only material. It is not evidence that physical-camera capture, tracking, or
  virtual webcam publication work.

Later slices that need those situations should add separate fixtures (or controlled live capture)
rather than treating this clip as general motion coverage.

## Verification

```powershell
(Get-FileHash fixtures\cache\webcam-loop.webm -Algorithm SHA256).Hash.ToLower()
# 81a22d3519fddc8dc6be30c8cc46525f09eca77817ccdcbf2311a45ae18ebeab
```

The public-workflow check re-verifies the cached file against the committed metadata before
launching the app, and the app itself re-validates size and checksum at startup and on
**Recheck input**.
