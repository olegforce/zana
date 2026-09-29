import { expect, it } from 'vitest';
import { mobileRecoveryPrompt } from './mobile-install-prompt.js';
it('bounds diagnostics and excludes arbitrary strings and invalid step values', () => {
  const prompt = mobileRecoveryPrompt({ step: Number.NaN, enabled: false, running: false, connectionMode: 'https://secret.example?token=private', hasInvitation: false, hasLivePhone: false });
  expect(prompt).toContain('Setup step: 1/4');
  expect(prompt).toContain('Connection method: unknown');
  expect(prompt).not.toContain('secret.example');
});
