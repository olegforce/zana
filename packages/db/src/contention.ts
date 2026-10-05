export const SQLITE_LOCK_WAIT_MS = 25;
export function isSqliteBusy(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return code === 'SQLITE_BUSY' || code.startsWith('SQLITE_BUSY_') || code === 'SQLITE_LOCKED' || code.startsWith('SQLITE_LOCKED_');
}

/** Only retry a complete atomic database operation, never a callback with external effects. */
export async function retrySqliteTransaction<T>(transaction: () => T, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let delay = 10;
  for (;;) {
    try { return transaction(); }
    catch (error) {
      if (!isSqliteBusy(error) || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(delay, Math.max(1, deadline - Date.now()))));
      delay = Math.min(100, delay * 2);
    }
  }
}
