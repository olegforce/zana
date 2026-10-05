import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMemoryInboxStore, createMemorySuggestionsStore } from '@zana-ai/zcc-server';
import { startMcpServer } from './mcp-server.js';

it('awaits confined document lookup through the real inbox MCP transport and preserves missing paths', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-async-doc-')); mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub/report.md'), 'Report');
  const store = createMemoryInboxStore();
  const handle = await startMcpServer({ inboxStore: store, suggestionsStore: createMemorySuggestionsStore(),
    projects: { get: id => id === 'project' ? { id, name: 'Fixture', path: dir, createdAt: 0, lastActiveAt: 0 } : null },
    resolveOrigin: () => ({ profile: 'claude', cwd: join(dir, 'sub') }), log: () => {} });
  const client = new Client({ name: 'fixture', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${handle.url}/mcp/project/session`)));
    const result = await client.callTool({ name: 'inbox_push', arguments: { docs: [{ path: 'report.md' }, { path: 'missing.md' }], comments: 'Complete' } });
    expect(result.isError).not.toBe(true);
    const { entries } = await store.read();
    expect(entries[0].docs.map(doc => doc.path)).toEqual(['sub/report.md', 'missing.md']);
  } finally { await client.close(); await handle.close(); rmSync(dir, { recursive: true, force: true }); }
});
