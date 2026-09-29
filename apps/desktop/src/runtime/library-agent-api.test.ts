import { expect, it, vi } from 'vitest';
import { runtimeLibraryAgentApi } from './library-agent-api.js';
import { pluginToolResultToResponse } from '../../../server/src/plugins/plugin-agent-tools.js';
import { LibraryAgentRequestSchema } from '@zana-ai/zcc-contracts/library-agent';

it('awaits shared Library results and stamps route identities after input', async () => {
  const doc = { relPath: 'note.md', title: 'Note', kind: 'md', updatedAt: 1 };
  const call = vi.fn(async (request: any) => pluginToolResultToResponse('library', request.action === 'list' ? [doc] : request.action === 'remove' ? { removed: true } : { ...doc, content: 'text' }));
  const api = runtimeLibraryAgentApi(call);
  expect(await api.agentList('owner')).toEqual([doc]);
  expect(await api.agentRead('owner', 'note.md')).toEqual({ ...doc, content: 'text' });
  expect(await api.agentWrite('owner', 'session', { relPath: 'note.md', content: 'text', projectId: 'spoof', sessionId: 'spoof', action: 'remove' } as any)).toMatchObject(doc);
  expect(call).toHaveBeenLastCalledWith({ action: 'write', projectId: 'owner', sessionId: 'session', relPath: 'note.md', content: 'text' });
  expect(await api.agentRemove('owner', 'note.md')).toBe(true);
});
it('does not turn offline, invalid or failed responses into success', async () => {
  const call = vi.fn().mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(pluginToolResultToResponse('library', { ok: false, error: 'conflict' }))
    .mockResolvedValueOnce({ success: false, contentItems: [] })
    .mockResolvedValueOnce({ success: true, contentItems: [] })
    .mockResolvedValueOnce({ success: true, contentItems: [{ type: 'inputText', text: 'invalid JSON' }] });
  const api = runtimeLibraryAgentApi(call);
  for (const message of ['offline', 'conflict', 'Library operation failed', 'Invalid Library response', 'JSON']) await expect(api.agentList('owner')).rejects.toThrow(message);
});
it('bounds the private protocol and rejects injected owner paths and authorship', () => {
  const base = { action: 'write', projectId: 'owner', relPath: 'note.md', content: 'text' };
  expect(LibraryAgentRequestSchema.safeParse(base).success).toBe(true);
  for (const patch of [{ scope: 'global' }, { hostId: 'other' }, { source: { kind: 'user' } }, { rootPath: '/' }, { relPath: '/abs' }, { relPath: '../other' }, { relPath: 'index.json' }, { relPath: '.secret/a' }, { relPath: 'a\\b' }, { relPath: 'C:/a' }, { relPath: 'a\0b' }, { content: 'x'.repeat(10 * 1024 * 1024 + 1) }, { tags: Array(101).fill('tag') }]) expect(LibraryAgentRequestSchema.safeParse({ ...base, ...patch }).success).toBe(false);
});
