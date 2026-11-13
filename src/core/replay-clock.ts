/**
 * Loop-aware frame clock for the recorded replay input.
 *
 * The media element resets its own `currentTime` at every loop seam. That
 * reset is deliberate, so the processing timestamp is built from the monotonic
 * wall clock (presented frame time) plus a loop counter: it keeps increasing
 * across seams instead of jumping backwards. Later tracking slices receive
 * this timestamp with each processed frame.
 */

/** A backward media-time jump larger than this is treated as a loop seam. */
export const LOOP_SEAM_THRESHOLD_MS = 250;

export interface ReplayFrameSample {
  /** `VideoFrameCallbackMetadata.mediaTime` in seconds. */
  mediaTimeSeconds: number;
  /** Monotonic `performance.now()` value of the presented frame. */
  presentedAtMs: number;
  /** Decoded duration of the clip in seconds. */
  loopDurationSeconds: number;
}

export interface ReplayFrameTimestamp {
  /** True only when the frame carries a valid, strictly increasing timestamp. */
  valid: boolean;
  increasing: boolean;
  loopSeam: boolean;
  /** Zero-based number of completed loops. */
  loopIndex: number;
  /** Loop-aware processing timestamp for later frames. */
  processingTimestampMs: number;
  /** Media time within the current loop, in milliseconds. */
  mediaTimeMs: number;
  /** Monotonic wall-clock time at which the frame was presented. */
  wallClockMs: number;
  /** Delta from the previous presented frame, in milliseconds. */
  frameDeltaMs: number;
  invalidReason: string | null;
}

export class ReplayTimeline {
  private loopIndex = 0;
  private seamCount = 0;
  private lastMediaTimeMs: number | null = null;
  private lastProcessingMs: number | null = null;
  private lastPresentedMs: number | null = null;

  get loops(): number {
    return this.loopIndex;
  }

  get seams(): number {
    return this.seamCount;
  }

  reset(): void {
    this.loopIndex = 0;
    this.seamCount = 0;
    this.lastMediaTimeMs = null;
    this.lastProcessingMs = null;
    this.lastPresentedMs = null;
  }

  record(sample: ReplayFrameSample): ReplayFrameTimestamp {
    const durationMs = sample.loopDurationSeconds * 1000;
    const mediaMs = sample.mediaTimeSeconds * 1000;
    const wallClockMs = sample.presentedAtMs;
    const finite = Number.isFinite(mediaMs) && Number.isFinite(wallClockMs) && Number.isFinite(durationMs);

    let loopSeam = false;
    if (finite && this.lastMediaTimeMs !== null && mediaMs < this.lastMediaTimeMs - LOOP_SEAM_THRESHOLD_MS) {
      loopSeam = true;
      this.loopIndex += 1;
      this.seamCount += 1;
    }

    const durationValid = finite && durationMs > 0;
    const processingTimestampMs = durationValid ? this.loopIndex * durationMs + mediaMs : mediaMs;
    const frameDeltaMs = this.lastPresentedMs === null ? 0 : wallClockMs - this.lastPresentedMs;
    const increasing = this.lastProcessingMs === null ? true : processingTimestampMs > this.lastProcessingMs;

    let invalidReason: string | null = null;
    if (!finite) invalidReason = 'non-finite frame timestamp';
    else if (!durationValid) invalidReason = 'unknown replay duration';
    else if (!increasing) invalidReason = 'processing timestamp did not increase';

    const valid = invalidReason === null;

    if (finite) {
      this.lastMediaTimeMs = mediaMs;
      this.lastPresentedMs = wallClockMs;
    }
    if (valid) {
      this.lastProcessingMs = processingTimestampMs;
    }

    return {
      valid,
      increasing,
      loopSeam,
      loopIndex: this.loopIndex,
      processingTimestampMs,
      mediaTimeMs: finite ? mediaMs : 0,
      wallClockMs,
      frameDeltaMs,
      invalidReason,
    };
  }
}
