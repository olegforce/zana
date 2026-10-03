export const TERMINAL_SCROLLBACK_TOTAL = 200_000;
export const TERMINAL_SCROLLBACK_MAX = 50_000;

/** Equal retained-history shares; viewport rows are additional xterm overhead. */
export function terminalScrollbackBudget(sessionCount: number): number {
  return Math.min(TERMINAL_SCROLLBACK_MAX, Math.floor(TERMINAL_SCROLLBACK_TOTAL / Math.max(1, sessionCount)));
}

interface Disposable { dispose(): void }
interface RendererAddon extends Disposable { onContextLoss(listener: () => void): Disposable }

/** Keep terminal buffers mounted, but retain a GPU context only while visible. */
export function createVisibleTerminalRenderer<T extends RendererAddon>(
  load: (addon: T) => void, create: () => T
): { setVisible(visible: boolean): void; dispose(): void } {
  let addon: T | undefined;
  let loss: Disposable | undefined;
  let disposed = false;
  let fallback = false;
  const release = () => {
    loss?.dispose();
    loss = undefined;
    const previous = addon;
    addon = undefined;
    try { previous?.dispose(); } catch { /* context already lost */ }
  };
  return {
    setVisible(visible) {
      if (disposed) return;
      if (!visible) { release(); return; }
      if (addon || fallback) return;
      try {
        addon = create();
        loss = addon.onContextLoss(() => { fallback = true; release(); });
        load(addon);
      } catch { fallback = true; release(); }
    },
    dispose() { disposed = true; release(); }
  };
}
