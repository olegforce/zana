const TRAILING_REFRESH_MS = 100;
export const THREAD_REFRESH_MAX_WAIT_MS = 250;

/** Refresh during continuous output as well as after its final event. */
export function createThreadRefreshScheduler(refresh: () => void): {
  schedule(): void;
  dispose(): void;
} {
  let trailingTimer: ReturnType<typeof setTimeout> | undefined;
  let maxWaitTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const clearPending = () => {
    clearTimeout(trailingTimer);
    clearTimeout(maxWaitTimer);
    trailingTimer = undefined;
    maxWaitTimer = undefined;
  };
  const flush = () => {
    clearPending();
    refresh();
  };

  return {
    schedule() {
      if (disposed) return;
      clearTimeout(trailingTimer);
      trailingTimer = setTimeout(flush, TRAILING_REFRESH_MS);
      // Only the trailing timer moves. A busy stream must not keep delaying work.
      maxWaitTimer ??= setTimeout(flush, THREAD_REFRESH_MAX_WAIT_MS);
    },
    dispose() {
      disposed = true;
      clearPending();
    }
  };
}
