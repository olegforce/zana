import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConversationThread, createEnvironment, getConversationThread, upsertHost } from '@zana-ai/zcc-db';
import { startProductServer, type ProductServer } from './product-server.js';

const { binaries } = vi.hoisted(() => ({ binaries: [] as string[] }));
vi.mock('@zana-ai/zcc-llm', async (importOriginal) => ({
  ...await importOriginal<typeof import('@zana-ai/zcc-llm')>(),
  ClaudeCliProvider: class {
    readonly id = 'claude-cli';
    constructor(binary: string) { binaries.push(binary); }
    async run() { return { ok: true, text: 'Configured test title', provider: this.id, ms: 0 }; }
  },
}));

let server: ProductServer | undefined;
let dataDir: string | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  binaries.length = 0;
});

describe('server background Claude configuration', () => {
  it.each([
    { name: 'canonical entry overrides stale legacy default', config: { harnesses: { byId: { claude: { binary: '/test/canonical-claude' } } }, claudeBinary: 'claude' }, expected: '/test/canonical-claude' },
    { name: 'canonical entry survives removal of the legacy field', config: { harnesses: { byId: { claude: { binary: '/test/canonical-claude' } } } }, expected: '/test/canonical-claude' },
    { name: 'legacy config remains supported', config: { claudeBinary: '/test/legacy-claude' }, expected: '/test/legacy-claude' },
    { name: 'unconfigured installations retain the default', config: {}, expected: 'claude' },
  ])('$name', async ({ config, expected }) => {
    dataDir = mkdtempSync(join(tmpdir(), 'zcc-llm-config-'));
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify(config));
    server = await startProductServer({ dataDir, origins: { serverPort: 0 } });
    const host = upsertHost(server.ctx.db, { name: 'test', hostKeyHash: 'h'.repeat(64) });
    const environment = createEnvironment(server.ctx.db, { projectId: 'project', hostId: host.id, path: dataDir });
    const thread = createConversationThread(server.ctx.db, {
      projectId: 'project', hostId: host.id, environmentId: environment.id, providerId: 'fake',
    });
    server.ctx.threadTitleNamer.request(thread.id, 'Name the test thread');
    await vi.waitFor(() => expect(getConversationThread(server!.ctx.db, thread.id)?.title).toBe('Configured test title'));
    expect(binaries).toEqual([expected]);

    // Summaries share the same resolver and must observe settings changed after boot.
    server.ctx.config.setConfig({ harnesses: { byId: { claude: { binary: '/test/updated-claude' } } } });
    await server.ctx.closeSummary.summarizeAndFollowUpFromLastTurn('project', {
      sessionId: thread.id, title: 'Test', lastTurn: 'Finished the test task',
    });
    expect(binaries).toEqual([expected, '/test/updated-claude']);
  });
});
