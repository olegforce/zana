import { mkdirSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from './fixtures/app.js';
import { makeFakeAgentBinary } from './sdk/harness.js';

test.use({ launchEnv: { ZCC_FAKE_PROVIDER: '1' }, initialConfig: { sponsorPromptDismissed: true } });

test('CLI Agent Library shares the product journal, revisions and authorship gates', async ({ app }) => {
  const { window, home } = app;
  const root = join(realpathSync(home), 'library-agent-project'); mkdirSync(root);
  const agent = makeFakeAgentBinary({ script: `
if [ "$1" = "--version" ]; then echo '2.1.220 (fake)'; exit 0; fi
printf '%s' "$ZCC_MCP_URL" > .library-mcp-url
exec cat
` });
  let sessionId: string | undefined;
  try {
    await window.evaluate(binary => window.cc.config.set({ claudeBinary: binary }), agent.path);
    const ids = await window.evaluate(async path => {
      const project = await window.cc.projects.add(path);
      if (!project.ok) throw new Error(project.message);
      const session = await window.cc.terminals.create({ projectId: project.value.id, profile: 'claude', cols: 80, rows: 24 });
      if (!session.ok) throw new Error(session.message);
      return { projectId: project.value.id, sessionId: session.value.id };
    }, root);
    sessionId = ids.sessionId;
    await expect.poll(() => existsSync(join(root, '.library-mcp-url'))).toBe(true);
    const route = readFileSync(join(root, '.library-mcp-url'), 'utf8');
    const call = async (name: string, args = {}) => {
      const response = await fetch(route, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
      expect(response.ok).toBe(true);
      const body = await response.json(); expect(body.error).toBeUndefined(); return body.result;
    };
    const content = 'Large shared agent document.\n'.repeat(40_000);
    const created = await call('library_write', { relPath: 'agent.txt', title: 'From CLI Agent', content });
    expect(created.isError, JSON.stringify(created)).not.toBe(true);
    const manifest = () => JSON.parse(readFileSync(join(root, '.zcc/library/index.json'), 'utf8'));
    const initial = manifest().docs.find((doc: any) => doc.relPath === 'agent.txt');
    expect(initial.source).toMatchObject({ kind: 'agent', projectId: ids.projectId, sessionId });
    const read = await window.evaluate(id => window.cc.library.read('project', 'agent.txt', id), ids.projectId);
    expect(read).toMatchObject({ ok: true, content, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect((await call('library_write', { relPath: 'agent.txt', title: 'Updated title' })).isError).not.toBe(true);
    expect(manifest().docs.find((doc: any) => doc.relPath === 'agent.txt')).toMatchObject({ id: initial.id, title: 'Updated title' });
    const saved = await window.evaluate(async ({ id, sha }) => window.cc.library.write('project', 'agent.txt', 'Human revision', id, sha), { id: ids.projectId, sha: read.ok ? read.sha256 : '' });
    expect(saved).toMatchObject({ ok: true });
    expect(JSON.parse((await call('library_read', { relPath: 'agent.txt' })).content[0].text)).toMatchObject({ content: 'Human revision', title: 'Updated title' });
    await window.evaluate(id => window.cc.library.add({ scope: 'project', projectId: id, relPath: 'user.md', title: 'User', content: 'Protected' }), ids.projectId);
    for (const name of ['library_write', 'library_remove']) expect((await call(name, { relPath: 'user.md', content: 'No' })).isError).toBe(true);
    expect(readFileSync(join(root, '.zcc/library/user.md'), 'utf8')).toBe('Protected');
    expect((await call('library_write', { relPath: '../outside.md', content: 'No' })).isError).toBe(true);
    const listed = JSON.parse((await call('library_list')).content[0].text);
    expect(listed.find((doc: any) => doc.relPath === 'agent.txt')).toMatchObject({ title: 'Updated title' });
    expect((await call('library_remove', { relPath: 'agent.txt' })).isError).not.toBe(true);
    expect(existsSync(join(root, '.zcc/library/agent.txt'))).toBe(false);
    expect(manifest().docs.map((doc: any) => doc.relPath)).toEqual(['user.md']);
    expect(existsSync(join(root, '.zcc/library-transaction.json'))).toBe(false);
  } finally {
    if (sessionId) await window.evaluate(id => window.cc.terminals.close(id), sessionId).catch(() => undefined);
    agent.cleanup();
  }
});
