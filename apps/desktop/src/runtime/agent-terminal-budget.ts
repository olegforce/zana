import type { Result, TerminalSession } from '@zana-ai/zcc-domain/product';

export const AGENT_SHELL_LIMIT = 3;
/** Trusted launch-side reservations include in-flight creates, not view tabs. */
export function createAgentTerminalBudget(isLive: (id: string) => boolean) {
  const owners = new Map<string, { pending: number; sessions: string[] }>();
  return {
    async launch(ownerId: string, validateOwner: () => Promise<boolean>, create: () => Promise<Result<TerminalSession>>): Promise<Result<TerminalSession>> {
      for (const [id, entry] of owners) {
        entry.sessions = entry.sessions.filter(isLive);
        if (!entry.pending && !entry.sessions.length) owners.delete(id);
      }
      if (!ownerId || ownerId.length > 128 || (!owners.has(ownerId) && owners.size >= 128)) {
        return { ok: false, code: 'DENIED', message: 'Terminal owner unavailable' };
      }
      const entry = owners.get(ownerId) ?? { pending: 0, sessions: [] };
      if (entry.pending + entry.sessions.length >= AGENT_SHELL_LIMIT) return { ok: false, code: 'DENIED', message: 'This agent already has three terminals. Reuse or close one.' };
      owners.set(ownerId, entry); entry.pending++;
      try {
        if (!await validateOwner()) return { ok: false, code: 'DENIED', message: 'Terminal owner does not belong to this project' };
        const result = await create();
        if (result.ok) entry.sessions.push(result.value.id);
        return result;
      } finally {
        entry.pending--;
        if (!entry.pending && !entry.sessions.length) owners.delete(ownerId);
      }
    }
  };
}
