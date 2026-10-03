import { describe, expect, it } from 'vitest';
import { isAgentsViewId } from './agents-view.js';
describe('Agents view preference', () => {
  it.each(['board', 'list', 'flow', 'plugin:agent-city/world', 'plugin:other.demo/view-1'])('accepts %s', (value) => expect(isAgentsViewId(value)).toBe(true));
  it.each([null, {}, '', 'world', 'plugin:', 'plugin:../../x', 'plugin:x/<script>', 'plugin:x/' + 'a'.repeat(241)])('rejects malformed keys %s', (value) => expect(isAgentsViewId(value)).toBe(false));
});
