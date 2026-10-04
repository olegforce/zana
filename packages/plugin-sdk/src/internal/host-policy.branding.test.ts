import { expect, it } from 'vitest';
import { assertAiServiceRegistrable, pluginCliCollisionWarning, providerWithoutBridgeMessage } from './host-policy.js';

it('explains CLI collisions using runnable commands and permits unique commands', () => {
  expect(pluginCliCollisionWarning('example', 'thread')).toContain('core command "zcc thread"');
  expect(pluginCliCollisionWarning('example', 'thread')).toContain('zcc plugin run example');
  expect(pluginCliCollisionWarning('example', 'my-custom-command')).toBeNull();
});

it('requires a declared host and preserves the actual build failure for recovery', () => {
  expect(() => assertAiServiceRegistrable({ id: 'custom', hostArtifact: null, hostArtifactProblem: null })).toThrow('needs a zcc.host entry');
  expect(assertAiServiceRegistrable({ id: 'custom', hostArtifact: null, hostArtifactProblem: 'Build failed' })).toEqual({ artifact: null, problem: 'Build failed' });
  const artifact = { hash: 'ready' };
  expect(assertAiServiceRegistrable({ id: 'custom', hostArtifact: artifact, hostArtifactProblem: null })).toEqual({ artifact, problem: null });
  expect(providerWithoutBridgeMessage('custom')).toContain('no "zcc.host" entry');
});
