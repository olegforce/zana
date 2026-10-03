import { getConversationThread, getThreadPluginMetadata, type ZccDatabase } from '@zana-ai/zcc-db';

/** The launching plugin declares this in its own persisted pluginMetadata.
 * Never infer the controlling surface from visibility, title, or a live window.
 * Only the origin plugin's namespace is authoritative. Descendants inherit it.
 */
export interface RemoteInteractionSurface { kind: 'remote'; label: string }
const UNKNOWN_REMOTE: RemoteInteractionSurface = { kind: 'remote', label: 'a remote conversation' };

export function remoteInteractionSurface(db: ZccDatabase, threadId: string): RemoteInteractionSurface | null {
  const seen = new Set<string>();
  let id: string | null = threadId;
  while (id && seen.size < 32) {
    if (seen.has(id)) return UNKNOWN_REMOTE;
    seen.add(id);
    const thread = getConversationThread(db, id);
    if (!thread) return seen.size === 1 ? null : UNKNOWN_REMOTE;
    if (thread.originPluginId) {
      const { metadata, corrupt } = getThreadPluginMetadata(db, id, thread.originPluginId);
      if (corrupt) return UNKNOWN_REMOTE;
      const surface = metadata.interactionSurface;
      if (surface !== undefined) {
        // A malformed declaration must not grant desktop presentation.
        const label = surface && typeof surface === 'object' && !Array.isArray(surface)
          && typeof surface.label === 'string' && /^[\p{L}\p{N} ._-]{1,60}$/u.test(surface.label)
          ? surface.label : UNKNOWN_REMOTE.label;
        return { kind: 'remote', label };
      }
    }
    id = thread.parentThreadId ?? null;
  }
  return id ? UNKNOWN_REMOTE : null;
}

export class DesktopPresentationUnavailable extends Error {
  readonly status = 409;
  readonly code = 'presentation_unavailable';
  constructor(label: string) {
    super(`The user is interacting through ${label} and cannot see Zana's desktop panels. Return the result in the conversation or use a supported remote preview. A desktop handoff must be opened by the user in Zana.`);
  }
}

export function assertDesktopPresentation(db: ZccDatabase, threadId: string): void {
  const surface = remoteInteractionSurface(db, threadId);
  if (surface) throw new DesktopPresentationUnavailable(surface.label);
}
