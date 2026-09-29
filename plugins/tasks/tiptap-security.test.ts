// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { mergeAttributes } from '@tiptap/core';
import { DOMSerializer } from '@tiptap/pm/model';
describe('Tiptap 2.27.3 upstream prototype fix (GHSA-cp6q-959q-f8rh)', () => {
  it('does not turn imported own __proto__ keys into inherited DOM handlers', () => {
    const untrusted = JSON.parse('{"__proto__":{"onerror":"alert(1)","src":"x-invalid://canary"},"class":"imported"}');
    const attrs = mergeAttributes({ class: 'base' }, untrusted);
    expect(Object.getPrototypeOf(attrs)).toBe(Object.prototype);
    expect(attrs.onerror).toBeUndefined(); expect(attrs.src).toBeUndefined();
    expect(attrs.class).toBe('base imported');
    const { dom } = DOMSerializer.renderSpec(document, ['img', attrs]);
    expect((dom as HTMLElement).hasAttribute('onerror')).toBe(false);
    expect((dom as HTMLElement).hasAttribute('src')).toBe(false);
  });
});
