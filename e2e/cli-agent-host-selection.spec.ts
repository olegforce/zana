import { test, expect } from './fixtures/app.js';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchCliAgent } from '../packages/control-sdk/src/cli-agents.js';
import { ProductHttpClient } from '../packages/control-sdk/src/http.js';

test('Control SDK preserves CLI Agent machine intent through the built HTTP and main authorization boundary', async ({ app, home }) => {
  const path = join(home, 'cli-selected-host'); mkdirSync(path);
  const project = await app.window.evaluate(path => window.cc.projects.add(path), path);
  if (!project.ok) throw new Error(project.message);
  const projectId = project.value.id;
  const http = new ProductHttpClient(new URL(app.window.url()).origin);
  const context = { runId: 'host-selection', dataDir: join(home, '.zcc'), tagged: false };
  const before = await app.window.evaluate(id => window.cc.terminals.list(id), projectId);
  await expect(launchCliAgent(http, {
    projectId, hostId: 'unregistered-machine', profile: 'shell', prompt: 'printf wrong > wrong-host.txt; sleep 30'
  }, context)).rejects.toThrow('secondary machines');
  expect(await app.window.evaluate(id => window.cc.terminals.list(id), projectId)).toEqual(before);
  expect(existsSync(join(path, 'wrong-host.txt'))).toBe(false);
  const primary = await app.window.evaluate(async () => (await fetch('/api/v1/hosts').then(response => response.json())).find((host: any) => host.isPrimary));
  expect(primary?.id).toBeTruthy();
  const agent = await launchCliAgent(http, {
    projectId, hostId: primary.id, profile: 'shell', prompt: 'printf selected > selected-host.txt; sleep 30'
  }, context);
  try {
    await expect.poll(() => existsSync(join(path, 'selected-host.txt'))).toBe(true);
    expect(readFileSync(join(path, 'selected-host.txt'), 'utf8')).toBe('selected');
    expect((await agent.refresh()).projectId).toBe(projectId);
  } finally { await agent.stop(); }
});
