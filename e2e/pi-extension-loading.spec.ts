import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test as base, expect } from './fixtures/app.js';

const reply = 'Pi embedded extension dependencies loaded';
const test = base.extend({
  launchEnv: async ({ home }, use) => {
    const agentDir = join(home, '.pi', 'agent');
    mkdirSync(join(agentDir, 'extensions'), { recursive: true });
    // Outside the checkout, with no node_modules: exercise the packed bridge's
    // extension loader, including both current and legacy import spellings.
    writeFileSync(join(agentDir, 'extensions', 'embedded.ts'), `
import { Type } from 'typebox';
import { Compile } from 'typebox/compile';
import { Check } from 'typebox/value';
import { Type as LegacyType } from '@sinclair/typebox';
import { Compile as LegacyCompile } from '@sinclair/typebox/compile';
import { Check as LegacyCheck } from '@sinclair/typebox/value';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream as legacyStream } from '@mariozechner/pi-ai';
import { createEventBus } from '@earendil-works/pi-coding-agent';
import { createEventBus as legacyEventBus } from '@mariozechner/pi-coding-agent';

export default function(pi) {
  const schema = Type.Object({ name: Type.String() });
  const value = { name: 'loaded' };
  if (!Compile(schema).Check(value) || !Check(schema, value) || Check(schema, { name: 1 }) ||
      !LegacyCompile(LegacyType.String()).Check('loaded') || !LegacyCheck(LegacyType.String(), 'loaded') ||
      legacyStream !== createAssistantMessageEventStream || legacyEventBus !== createEventBus) {
    throw new Error('Embedded module map is inconsistent');
  }
  createEventBus();
  pi.registerTool({ name: 'embedded_probe', label: 'Embedded probe', description: 'Fixture tool',
    parameters: schema, execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }) });
  pi.registerProvider('embedded-fixture', {
    baseUrl: 'http://127.0.0.1:1', apiKey: 'fixture-only', api: 'embedded-fixture-api',
    models: [{ id: 'test', name: 'Embedded fixture', input: ['text'], reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }],
    streamSimple(model) {
      const stream = createAssistantMessageEventStream();
      const message = { role: 'assistant', content: [{ type: 'text', text: ${JSON.stringify(reply)} }],
        api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => {
        stream.push({ type: 'start', partial: message });
        stream.push({ type: 'text_start', contentIndex: 0, partial: message });
        stream.push({ type: 'text_delta', contentIndex: 0, delta: ${JSON.stringify(reply)}, partial: message });
        stream.push({ type: 'text_end', contentIndex: 0, content: ${JSON.stringify(reply)}, partial: message });
        stream.push({ type: 'done', reason: 'stop', message });
        stream.end();
      });
      return stream;
    }
  });
}
`);
    await use({ PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1' });
  }
});

test('Pi loads TypeBox and SDK imports from its packed bridge through a real Electron thread', async ({ app, home }) => {
  test.setTimeout(90_000);
  const window = app.window;
  const path = join(home, 'pi-project');
  mkdirSync(path);
  const id = await window.evaluate(async path => {
    const project = await window.cc.projects.add(path);
    if (!project.ok) throw new Error(project.message);
    const response = await fetch('/api/v1/threads', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.value.id, providerId: 'pi', model: 'embedded-fixture/test', permissionMode: 'full', reasoningLevel: 'none', input: 'Probe embedded dependencies' }) });
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
  await expect(window.getByTestId('thread-timeline')).toContainText(reply);
  const timeline = await window.evaluate(async id => (await fetch(`/api/v1/threads/${id}/timeline`)).json(), id);
  expect(JSON.stringify(timeline)).not.toContain('Failed to load Pi extension');
  await expect.poll(() => window.evaluate(async id => (await (await fetch(`/api/v1/threads/${id}`)).json()).thread.status, id)).toBe('idle');
});
