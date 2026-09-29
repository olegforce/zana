// Adapted from BB plugins/monaco-editor/server.ts (MIT; see docs/third-party).
import { MAX_EDITABLE_BYTES, parseFileSource } from './file-rpc.js';

export default function plugin(zcc) {
  zcc.rpc.method('read', async (input) => {
    const file = parseFileSource(input);
    try {
      const result = await zcc.sdk.files.readProject({ path: file.path, source: file.source });
      if (result.contentEncoding !== 'utf8') return { kind: 'unsupported', reason: 'This file is not text' };
      if (result.sizeBytes > MAX_EDITABLE_BYTES) return { kind: 'unsupported', reason: 'This file is too large to edit' };
      return { kind: 'text', content: result.content, sha256: result.sha256 };
    } catch (error) {
      if (error?.code === 'unsupported') return { kind: 'unsupported', reason: error.message };
      throw error;
    }
  });
  zcc.rpc.method('write', async (input) => {
    const file = parseFileSource(input);
    if (typeof file.content !== 'string') throw new Error('content is required');
    try {
      return await zcc.sdk.files.writeProject({ path: file.path, source: file.source, content: file.content, expectedSha256: file.expectedSha256 });
    } catch (error) {
      if (error?.code === 'unsupported') return { outcome: 'unsupported', reason: error.message };
      throw error;
    }
  });
}
