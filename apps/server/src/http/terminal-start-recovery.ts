import type { ProductTerminalRecord } from './product-context.js';

/** Preserve the host/session binding when a start acknowledgement is lost.
 * Inspired by BB terminal-session-lifecycle createTerminalSessionFromLaunchTarget.
 * A disconnected daemon may already be running it. Never retry the launch or
 * discard the only record that can address that process after reconnect.
 */
export async function recoverFailedTerminalStart(
  record: ProductTerminalRecord,
  stop: () => Promise<unknown>
): Promise<void> {
  try {
    await stop();
    record.status = 'exited';
    record.finishedAt ??= Date.now();
  } catch {
    // Keep 'starting' (or a received exit) until the operator can close it.
    // It still counts toward capacity and prevents removing an in-use source.
  }
}
