import { expect, it } from 'vitest';
import type { ThreadEvent } from '@zana-ai/zcc-domain/thread-runtime';
import { checkPresentationIconsDeclared } from './scenarios.js';

function itemEvent(type: string, glyph?: string, server?: string): ThreadEvent {
  return { type: 'item/completed', item: { id: 'item', type, ...(server ? { server } : {}), ...(glyph ? { presentation: { icon: { glyph } } } : {}) } } as ThreadEvent;
}

it('checks provider icons while leaving current and saved host-tool presentations to their owner', () => {
  const icons = { pluginId: 'provider', names: ['agent'] };
  for (const server of ['zcc', 'bb']) expect(checkPresentationIconsDeclared([itemEvent('toolCall', 'other/plugin', server)], icons).status).toBe('skipped');
  expect(checkPresentationIconsDeclared([{ type: 'turn/started' } as ThreadEvent, itemEvent('assistantMessage')], icons).status).toBe('skipped');
  expect(checkPresentationIconsDeclared([itemEvent('toolCall', 'Terminal', 'external'), itemEvent('assistantMessage', 'provider/agent')], icons).status).toBe('pass');
  for (const glyph of ['other/agent', 'provider/unknown']) {
    const result = checkPresentationIconsDeclared([itemEvent('toolCall', glyph, 'external')], icons);
    expect(result.status).toBe('fail'); expect(result.detail).toContain('provider/unhandled');
  }
  expect(checkPresentationIconsDeclared([itemEvent('toolCall', 'provider/agent')], { pluginId: 'provider', names: [] }).detail).toContain('declared: none');
});
