import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test as base, expect } from './fixtures/app.js';

const reply = 'Pi native extension and Zana tools loaded';
const cli = process.env.ZCC_E2E_PI_CLI ?? resolve(import.meta.dirname,
  '../plugins/provider-pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
const nativePackage = process.env.ZCC_E2E_SF_PI_DIR;
const test = base.extend({
  launchEnv: async ({ home }, use) => {
    const agentDir = join(home, '.pi', 'agent');
    mkdirSync(join(agentDir, 'extensions'), { recursive: true });
    if (nativePackage) {
      writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: [nativePackage] }));
    }
    // Outside the checkout, with no node_modules. These imports and native
    // tools must come from the launched CLI, independently of Zana's SDK.
    writeFileSync(join(agentDir, 'extensions', 'native.ts'), `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from 'typebox';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createEventBus } from '@earendil-works/pi-coding-agent';

export default function(pi) {
  createEventBus();
  pi.registerTool({ name: 'native_probe', label: 'Native probe', description: 'Fixture tool',
    parameters: Type.Object({}), execute: async () => {
      const active = pi.getActiveTools();
      if (!active.includes('native_probe') || !active.some(name => name.includes('inbox_push'))) {
        throw new Error('Native extension or injected Zana tools are missing');
      }
      writeFileSync(join(process.cwd(), 'native-proof.json'), JSON.stringify({
        active, cwd: process.cwd(), home: process.env.HOME, version: process.version, cli: process.argv[1]
      }));
      return { content: [{ type: 'text', text: 'native-result-' + '界'.repeat(12_000) + '-complete' }] };
    }
  });
  pi.registerProvider('native-fixture', {
    baseUrl: 'http://127.0.0.1:1', apiKey: 'fixture-only', api: 'embedded-fixture-api',
    models: [{ id: 'test', name: 'Native fixture', input: ['text'], reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }],
    streamSimple(model, context) {
      const result = context.messages.findLast(message => message.role === 'toolResult');
      const needsApex = ${JSON.stringify(Boolean(nativePackage))} && result?.toolName === 'native_probe';
      const done = result && !needsApex;
      const content = done ? [{ type: 'text', text: ${JSON.stringify(reply)} }] : needsApex ?
        [{ type: 'toolCall', id: 'apex-call', name: 'sf_apex', arguments: { action: 'author.plan', intent: 'Bulkify local Apex Contact counts. No org access or deployment.' } }] :
        [{ type: 'toolCall', id: 'native-call', name: 'native_probe', arguments: {} }];
      const stream = createAssistantMessageEventStream();
      const message = { role: 'assistant', content,
        api: model.api, provider: model.provider, model: model.id, stopReason: done ? 'stop' : 'toolUse', timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => {
        stream.push({ type: 'start', partial: message });
        if (result && (result.isError || (result.toolName === 'native_probe' && !result.content[0].text.endsWith('-complete')))) {
            throw new Error('Native tool result failed or was truncated');
        }
        if (done) {
          stream.push({ type: 'text_start', contentIndex: 0, partial: message });
          stream.push({ type: 'text_delta', contentIndex: 0, delta: ${JSON.stringify(reply)}, partial: message });
          stream.push({ type: 'text_end', contentIndex: 0, content: ${JSON.stringify(reply)}, partial: message });
        } else {
          stream.push({ type: 'toolcall_start', contentIndex: 0, partial: message });
          stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: content[0], partial: message });
        }
        stream.push({ type: 'done', reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    }
  });
}
`);
    await use({ PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1',
      ZCC_PI_BRIDGE_COMMAND: process.execPath, ZCC_PI_BRIDGE_ARGS: JSON.stringify([cli]) });
  }
});

const missing = base.extend({ launchEnv: [{ ZCC_PI_BRIDGE_COMMAND: '/missing-zcc-pi-cli' }, { option: true }] });
missing('Pi reports a missing installed CLI through a real Electron thread', async ({ app, home }) => {
  const path = join(home, 'missing-pi-project');
  mkdirSync(path);
  const result = await app.window.evaluate(async path => {
    const project = await window.cc.projects.add(path);
    if (!project.ok) throw new Error(project.message);
    const response = await fetch('/api/v1/threads', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.value.id, providerId: 'pi', permissionMode: 'full', input: 'Probe missing CLI' }) });
    return { ok: response.ok, data: await response.json() };
  }, path);
  if (!result.ok) {
    expect(JSON.stringify(result.data)).toMatch(/pi.*(CLI|executable|available|installed)/i);
    return;
  }
  const id = result.data.thread.id;
  await expect.poll(() => app.window.evaluate(async id => (await (await fetch(`/api/v1/threads/${id}`)).json()).thread.status, id), { timeout: 30_000 }).toBe('error');
  const events = await app.window.evaluate(async id => (await fetch(`/api/v1/threads/${id}/events?limit=100`)).json(), id);
  expect(JSON.stringify(events)).toContain('Could not find the pi CLI');
});

test('Pi launches its CLI and preserves native extension tools through a real Electron thread', async ({ app, home }) => {
  test.setTimeout(90_000);
  const window = app.window;
  const path = join(home, 'pi-project');
  mkdirSync(path);
  const id = await window.evaluate(async path => {
    const project = await window.cc.projects.add(path);
    if (!project.ok) throw new Error(project.message);
    const response = await fetch('/api/v1/threads', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.value.id, providerId: 'pi', model: 'native-fixture/test', permissionMode: 'full', reasoningLevel: 'none', input: 'Probe native extension' }) });
    const result = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(result));
    return result.thread.id as string;
  }, path);
  await window.evaluate(id => {
    history.pushState({}, '', `/threads/${id}`);
    dispatchEvent(new PopStateEvent('popstate'));
  }, id);
  await expect.poll(() => window.evaluate(async id => (await (await fetch(`/api/v1/threads/${id}`)).json()).thread.status, id), { timeout: 30_000 }).toMatch(/^(idle|error)$/);
  const snapshot = await window.evaluate(async id => (await fetch(`/api/v1/threads/${id}/events?limit=100`)).json(), id);
  expect(JSON.stringify(snapshot)).toContain(reply);
  expect(JSON.stringify(snapshot)).toContain('native_probe');
  expect(JSON.stringify(snapshot)).toContain('native-result-' + '界'.repeat(12_000) + '-complete');
  const proof = JSON.parse(readFileSync(join(path, 'native-proof.json'), 'utf8'));
  expect(proof).toMatchObject({ cwd: realpathSync(path), home });
  expect(realpathSync(proof.cli)).toBe(realpathSync(cli));
  expect(proof.active).toContain('native_probe');
  expect(proof.active.some((name: string) => name.includes('inbox_push'))).toBe(true);
  if (nativePackage) {
    expect(proof.active).toContain('sf_apex');
    expect(JSON.stringify(snapshot)).toContain('author.plan');
    expect(JSON.stringify(snapshot)).toContain('Apex authoring plan:');
  }
  await expect(window.getByTestId('thread-timeline')).toContainText(reply);
  const timeline = await window.evaluate(async id => (await fetch(`/api/v1/threads/${id}/timeline`)).json(), id);
  expect(JSON.stringify(timeline)).not.toContain('Failed to load Pi extension');
  await expect.poll(() => window.evaluate(async id => (await (await fetch(`/api/v1/threads/${id}`)).json()).thread.status, id)).toBe('idle');
});
