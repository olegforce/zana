import { useEffect, useRef } from 'react';
import { product } from '../../../lib/product-client.js';
import { useData, useUi } from '../../../store.js';
import type { ClosableSecondaryTab, ThreadSecondaryPanelState } from './threadSecondaryPanelState.js';

export const AGENT_TERMINAL_CAP = 3;
export const AGENT_TERMINAL_OPENER_KEY = 'agent-terminal';

export type ThreadOpenTerminalIntent = {
  command: string | null;
  title: string | null;
};

const pendingByThread = new Map<string, ThreadOpenTerminalIntent[]>();
const projectShellsByOwner = new Map<string, string[]>();
const openingByOwner = new Map<string, { pending: number; tail: Promise<unknown> }>();
const MAX_PENDING_OPENS = 12;
function serializeOpen(ownerId: string, run: () => Promise<void>): Promise<void> {
  const queue = openingByOwner.get(ownerId) ?? { pending: 0, tail: Promise.resolve() };
  if (queue.pending >= MAX_PENDING_OPENS || (!openingByOwner.has(ownerId) && openingByOwner.size >= 128)) return Promise.reject(new Error('Too many pending terminal requests'));
  openingByOwner.set(ownerId, queue); queue.pending++;
  const task = queue.tail.catch(() => {}).then(run);
  queue.tail = task;
  return task.finally(() => { if (--queue.pending === 0) openingByOwner.delete(ownerId); });
}

export function forgetAgentTerminal(sessionId: string): void {
  for (const [owner, ids] of projectShellsByOwner) {
    const remaining = ids.filter(id => id !== sessionId);
    if (remaining.length) projectShellsByOwner.set(owner, remaining); else projectShellsByOwner.delete(owner);
  }
}

function reportOpenError(error: unknown) {
  useUi.getState().pushToast(error instanceof Error ? error.message : 'Could not open terminal', 'error');
}

export function resetThreadOpenTerminalBuffer(): void {
  pendingByThread.clear();
  projectShellsByOwner.clear();
  openingByOwner.clear();
}

export function bufferThreadOpenTerminal(threadId: string, terminal: ThreadOpenTerminalIntent): void {
  const queued = pendingByThread.get(threadId) ?? [];
  if (queued.length >= MAX_PENDING_OPENS || (!pendingByThread.has(threadId) && pendingByThread.size >= 128)) { reportOpenError(new Error('Too many pending terminal requests')); return; }
  queued.push(terminal);
  pendingByThread.set(threadId, queued);
}

export function consumePendingOpenTerminal(threadId: string): ThreadOpenTerminalIntent | null {
  const queued = pendingByThread.get(threadId);
  if (!queued || queued.length === 0) return null;
  const next = queued.shift() ?? null;
  if (!queued.length) pendingByThread.delete(threadId);
  return next;
}

export const THREAD_OPEN_TERMINAL_EVENT = 'zcc-thread-open-terminal';

export function parseThreadOpenTerminalPayload(payload: unknown): {
  threadId: string;
  projectId: string | null;
  terminal: ThreadOpenTerminalIntent | null;
} | null {
  if (!payload || typeof payload !== 'object') return null;
  const row = payload as Record<string, unknown>;
  if (typeof row.threadId !== 'string' || row.threadId.length === 0) return null;
  const projectId = typeof row.projectId === 'string' && row.projectId.length > 0 ? row.projectId : null;
  if (row.terminal == null) return { threadId: row.threadId, projectId, terminal: null };
  if (typeof row.terminal !== 'object' || Array.isArray(row.terminal)) {
    return { threadId: row.threadId, projectId, terminal: null };
  }
  const terminal = row.terminal as Record<string, unknown>;
  const command = typeof terminal.command === 'string' && terminal.command.trim()
    ? terminal.command.trim()
    : null;
  const title = typeof terminal.title === 'string' && terminal.title.trim()
    ? terminal.title.trim()
    : null;
  return { threadId: row.threadId, projectId, terminal: { command, title } };
}

function tabTitleFor(intent: ThreadOpenTerminalIntent): string {
  return intent.title || intent.command || 'Terminal';
}

function commandPayload(command: string): string {
  return command.endsWith('\n') ? command : `${command}\n`;
}

type PanelCommands = {
  state: Pick<ThreadSecondaryPanelState, 'tabs'>;
  addTab: (tab: Omit<ClosableSecondaryTab, 'id'> & { id?: string }) => void;
  activateTab: (tabId: string) => void;
};

export function agentOwnedTerminalTabs(tabs: ClosableSecondaryTab[]): ClosableSecondaryTab[] {
  return tabs.filter(
    (tab) => tab.kind === 'terminal' && tab.openerKey === AGENT_TERMINAL_OPENER_KEY && Boolean(tab.sessionId)
  );
}

export async function openThreadPanelTerminal(args: {
  ownerId?: string;
  projectId: string;
  cwd?: string | null;
  intent: ThreadOpenTerminalIntent;
  panel: PanelCommands;
  isCurrent?: () => boolean;
}): Promise<void> {
  const ownerId = args.ownerId ?? args.projectId;
  return serializeOpen(ownerId, async () => {
    if (args.isCurrent && !args.isCurrent()) return;
    const tabs = agentOwnedTerminalTabs(args.panel.state.tabs);
    const ids = [...new Set([...tabs.map(tab => tab.sessionId!), ...(projectShellsByOwner.get(ownerId) ?? [])])];
    const sessions = useData.getState().terminals[args.projectId] ?? [];
    const owned = ids.filter(id => sessions.find(session => session.id === id)?.status !== 'exited');
    projectShellsByOwner.set(ownerId, owned);
    if (owned.length >= AGENT_TERMINAL_CAP) {
      const last = owned[owned.length - 1];
      args.panel.activateTab(tabs.find(tab => tab.sessionId === last)?.id ?? last);
      if (args.intent.command) {
        await product.terminals.write(last, commandPayload(args.intent.command));
      }
      return;
    }
    const created = await product.terminals.create({
      projectId: args.projectId,
      agentOwnerId: args.ownerId,
      profile: 'shell',
      cwd: args.cwd ?? undefined,
      cols: 80,
      rows: 24,
      prompt: args.intent.command ?? undefined,
      title: tabTitleFor(args.intent)
    });
    if (created.ok) {
      if (args.isCurrent && !args.isCurrent()) {
        if (!await product.terminals.close(created.value.id)) throw new Error('Could not stop the terminal opened after navigation. Reconnect and close it from the project.');
        useData.getState().dismissTerminals([created.value.id]);
        return;
      }
      projectShellsByOwner.set(ownerId, [...owned, created.value.id]);
      args.panel.addTab({
        id: created.value.id,
        kind: 'terminal',
        title: tabTitleFor(args.intent),
        sessionId: created.value.id,
        openerKey: AGENT_TERMINAL_OPENER_KEY
      });
    } else throw new Error(created.message);
  });
}

function liveProjectShells(ownerId: string, projectId: string): string[] {
  const ids = projectShellsByOwner.get(ownerId) ?? [];
  const live = useData.getState().terminals[projectId] ?? [];
  const liveIds = new Set(live.filter((session) => session.status !== 'exited').map((session) => session.id));
  const next = ids.filter((id) => liveIds.has(id));
  if (next.length) projectShellsByOwner.set(ownerId, next); else projectShellsByOwner.delete(ownerId);
  return next;
}

export function findCliAgentSession(threadId: string): { id: string; projectId: string; cwd?: string } | null {
  const terminals = useData.getState().terminals;
  for (const [projectId, sessions] of Object.entries(terminals)) {
    const session = sessions.find((row) => row.id === threadId && row.status !== 'exited');
    if (session) return { id: session.id, projectId, cwd: session.cwd };
  }
  return null;
}

export async function openProjectStripTerminal(args: {
  ownerId: string;
  projectId: string;
  cwd?: string | null;
  intent: ThreadOpenTerminalIntent;
}): Promise<void> {
  return serializeOpen(args.ownerId, async () => {
    const owned = liveProjectShells(args.ownerId, args.projectId);
    if (owned.length >= AGENT_TERMINAL_CAP) {
      const last = owned[owned.length - 1];
      if (last) {
        useUi.getState().selectTab(args.projectId, last);
        if (args.intent.command) {
          await product.terminals.write(last, commandPayload(args.intent.command));
        }
      }
      return;
    }
    const created = await useData.getState().createTerminal(args.projectId, 'shell', 80, 24, {
      agentOwnerId: args.ownerId,
      cwd: args.cwd ?? undefined,
      prompt: args.intent.command ?? undefined,
      title: tabTitleFor(args.intent)
    });
    if (!created) return;
    const next = [...owned, created.id];
    projectShellsByOwner.set(args.ownerId, next);
    useUi.getState().selectTab(args.projectId, created.id);
  });
}

export function useThreadOpenTerminalSignal({
  threadId,
  environmentId,
  projectId,
  cwd,
  panel
}: {
  threadId: string | null | undefined;
  environmentId: string | null | undefined;
  projectId: string | null | undefined;
  cwd?: string | null;
  panel: PanelCommands;
}): void {
  const openRef = useRef<(intent: ThreadOpenTerminalIntent) => void>(() => undefined);
  const current = useRef({ threadId, active: true });
  current.current.threadId = threadId;
  useEffect(() => { current.current.active = true; return () => { current.current.active = false; }; }, []);
  openRef.current = (intent) => {
    if (!projectId) return;
    const owner = threadId;
    void openThreadPanelTerminal({ ownerId: threadId ?? undefined, projectId, cwd, intent, panel,
      isCurrent: () => current.current.active && current.current.threadId === owner }).catch(reportOpenError);
  };

  useEffect(() => {
    if (threadId == null || environmentId === undefined || !projectId) return;
    const drain = () => {
      let intent = consumePendingOpenTerminal(threadId);
      while (intent) {
        openRef.current(intent);
        intent = consumePendingOpenTerminal(threadId);
      }
    };
    drain();
    const onLocal = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId?: string }>).detail;
      if (detail?.threadId === threadId) drain();
    };
    window.addEventListener(THREAD_OPEN_TERMINAL_EVENT, onLocal);
    return () => {
      window.removeEventListener(THREAD_OPEN_TERMINAL_EVENT, onLocal);
    };
  }, [environmentId, projectId, threadId]);
}

export function useCliAgentTerminalSignal(): void {
  useEffect(() => {
    const stopExit = product.terminals.onExit(id => forgetAgentTerminal(id));
    const stopOpen = product.threads.onOpen((payload) => {
      const parsed = parseThreadOpenTerminalPayload(payload);
      if (!parsed?.terminal) return;
      const session = findCliAgentSession(parsed.threadId);
      if (!session) {
        bufferThreadOpenTerminal(parsed.threadId, parsed.terminal);
        window.dispatchEvent(new CustomEvent(THREAD_OPEN_TERMINAL_EVENT, { detail: { threadId: parsed.threadId } }));
        return;
      }
      void openProjectStripTerminal({
        ownerId: parsed.threadId,
        projectId: session.projectId,
        cwd: session.cwd,
        intent: parsed.terminal
      }).catch(reportOpenError);
    });
    return () => { stopOpen(); stopExit(); };
  }, []);
}
