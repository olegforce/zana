import type { LibraryAgentRequest } from '@zana-ai/zcc-contracts/library-agent';
import type { ToolCallResponse } from '@zana-ai/zcc-domain/thread-runtime';
import type { LibraryAgentApi, LibraryAgentDocument } from '../../../server/src/services/library/library-mcp-tools.js';

/** Route identities stay in main; content/manifest operations share the server
 * transaction queue with Modern threads and browser/native document edits. */
export function runtimeLibraryAgentApi(call: (request: LibraryAgentRequest) => Promise<ToolCallResponse>): LibraryAgentApi {
  const invoke = async <T>(request: LibraryAgentRequest): Promise<T> => {
    const response = await call(request);
    const text = response.contentItems.find(item => item.type === 'inputText')?.text;
    if (!response.success) throw new Error(text || 'Library operation failed');
    if (typeof text !== 'string') throw new Error('Invalid Library response');
    return JSON.parse(text) as T;
  };
  return {
    agentList: projectId => invoke<LibraryAgentDocument[]>({ action: 'list', projectId }),
    agentRead: (projectId, relPath) => invoke<LibraryAgentDocument & { content: string }>({ action: 'read', projectId, relPath }),
    agentWrite: (projectId, sessionId, input) => invoke<LibraryAgentDocument>({ ...input, action: 'write', projectId, sessionId }),
    agentRemove: async (projectId, relPath) => (await invoke<{ removed: boolean }>({ action: 'remove', projectId, relPath })).removed
  };
}
