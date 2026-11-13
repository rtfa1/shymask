/**
 * Generation gate for asynchronous selections (for example effect switches that
 * load a mask asset).
 *
 * A newer selection calls `begin()`, which invalidates every older generation.
 * An async loader must call `settle()` after its last `await`; a stale result is
 * handed to the discard callback instead of being committed. `settle` is
 * synchronous, so committing the live value cannot interleave with another
 * selection in the same JavaScript task.
 */
export class SwitchGeneration {
  private token = 0;

  /** Starts a new generation and returns the token its result must carry. */
  begin(): number {
    this.token += 1;
    return this.token;
  }

  /** Invalidates in-flight generations without starting a new load. */
  invalidate(): void {
    this.token += 1;
  }

  isCurrent(token: number): boolean {
    return token === this.token;
  }

  /**
   * Commits `value` only when `token` is still current; otherwise calls
   * `discard` with the stale value. Returns true when the commit ran.
   */
  settle<T>(token: number, value: T, commit: (value: T) => void, discard?: (value: T) => void): boolean {
    if (token !== this.token) {
      discard?.(value);
      return false;
    }
    commit(value);
    return true;
  }
}
