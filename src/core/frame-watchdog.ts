/**
 * Timer-based watchdog for a silent decode stall.
 *
 * `requestVideoFrameCallback` only runs when Chromium presents a new frame, so
 * a decoder that stops presenting frames would otherwise leave the last
 * processed frame visible indefinitely. The watchdog compares the monotonic
 * clock against the last presented frame and reports a stall once the gap
 * exceeds the same threshold used for the loop-seam decode gap (ADR-0003: the
 * output must be hidden, not frozen).
 *
 * The threshold is deliberately above one ~24 Hz frame interval so a single
 * missed frame at a loop seam keeps the last processed frame visible instead of
 * flashing the paused screen.
 */

export const DECODE_STALL_THRESHOLD_MS = 250;

export class FrameWatchdog {
  private lastFrameAtMs: number | null = null;
  private stalled = false;

  /**
   * Start watching from `nowMs`. No frame has been presented since this call;
   * used on Start and Resume so a stale baseline cannot trip the watchdog.
   */
  arm(nowMs: number): void {
    this.lastFrameAtMs = nowMs;
    this.stalled = false;
  }

  /**
   * Stop watching and forget the baseline. Used on manual pause, Recheck input
   * and input disposal; while no frame is expected, nothing should be hidden.
   */
  disarm(): void {
    this.lastFrameAtMs = null;
    this.stalled = false;
  }

  /** A frame was presented, so the decoder is alive and any stall is over. */
  noteFrame(nowMs: number): void {
    this.lastFrameAtMs = nowMs;
    this.stalled = false;
  }

  get isStalled(): boolean {
    return this.stalled;
  }

  /**
   * Evaluate one tick. Returns true while the time since the last presented
   * frame exceeds {@link DECODE_STALL_THRESHOLD_MS} and a frame is expected.
   * When no frame is expected (not started, manual pause, no active effect),
   * the watchdog clears instead of hiding the output.
   */
  check(nowMs: number, expectFrame: boolean): boolean {
    if (!expectFrame || this.lastFrameAtMs === null) {
      this.stalled = false;
      return false;
    }
    this.stalled = nowMs - this.lastFrameAtMs > DECODE_STALL_THRESHOLD_MS;
    return this.stalled;
  }
}
