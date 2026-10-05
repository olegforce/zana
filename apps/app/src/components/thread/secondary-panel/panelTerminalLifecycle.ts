import type { ClosableSecondaryTab } from './threadSecondaryPanelState.js';

/** Explicit close releases shells created by the panel. Other view references
 * may opt out with shared-terminal; hide/navigation never invoke this path. */
export async function closePanelTab(tab: ClosableSecondaryTab | undefined, tabs: readonly ClosableSecondaryTab[], deps: {
  close(id: string): Promise<boolean>;
  waitForExit?(id: string): Promise<boolean>;
  released(id: string): void;
  remove(id: string): void;
}) {
  if (!tab) return;
  const id = tab.sessionId;
  if (tab.kind === 'terminal' && id && tab.openerKey !== 'shared-terminal'
    && !tabs.some(other => other.id !== tab.id && other.kind === 'terminal' && other.sessionId === id)) {
    if (!await deps.close(id)) throw new Error('Could not stop this terminal. Reconnect and close it again.');
    if (deps.waitForExit && !await deps.waitForExit(id)) throw new Error('Terminal has not stopped yet. Try closing it again.');
    deps.released(id);
  }
  deps.remove(tab.id);
}

/** An accepted native close can precede process exit (interactive shells may
 * ignore TERM until the process-tree hard kill). Keep the view and its budget
 * until the roster confirms exit, with a deadline and no persistent timer. */
export async function waitForPanelTerminalExit(id: string, list: () => Promise<readonly { id: string; status: string }[]>, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    const session = (await list()).find(session => session.id === id);
    if (!session || session.status === 'exited') return true;
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return false;
}
