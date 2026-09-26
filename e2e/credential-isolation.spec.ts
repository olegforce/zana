import { test, expect } from './fixtures/app.js';
import { DISABLED_CLAUDE_BINARY } from './fixtures/app-config.js';

test.use({ launchEnv: { ZCC_FAKE_PROVIDER: '1' } });

test('background naming cannot invoke real Claude from an isolated test home', async ({ app }) => {
  const binary = await app.window.evaluate(async () => (await window.cc.config.get()).claudeBinary);
  expect(binary).toBe(DISABLED_CLAUDE_BINARY);
  // Exercise the real renderer -> IPC -> LLM provider -> child process boundary.
  const result = await app.window.evaluate(() => window.cc.llmPrompts.test('builtin:tab-namer', { prompt: 'Name this isolation check' }));
  expect(result.ok).toBe(false);
  expect(result.error).toContain('Real Claude is disabled in deterministic E2E tests');
});
