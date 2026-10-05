import hljs from 'highlight.js/lib/common';
import { describe, expect, it, vi } from 'vitest';
import {
  highlightMarkdownCode,
  languageFromMarkdownClassName
} from './markdown-code-highlight.js';

describe('highlightMarkdownCode', () => {
  it('returns a stable innerHTML object on cache hits', () => {
    const args = { code: 'const x: number = 1;', language: 'typescript' };
    const first = highlightMarkdownCode(args);
    const second = highlightMarkdownCode(args);
    expect(first).toBe(second);
    expect(first.__html).toContain('hljs-');
    expect(first.__html).not.toContain('<script');
  });

  it('escapes HTML when highlighting unknown source', () => {
    const html = highlightMarkdownCode({
      code: 'const el = <div>{"a < b"}</div>;',
      language: 'xml'
    });
    expect(html.__html).not.toContain('<div>');
    expect(html.__html).toContain('&lt;');
  });

  it('reads a fenced language from the markdown className', () => {
    expect(languageFromMarkdownClassName('language-ts')).toBe('ts');
    expect(languageFromMarkdownClassName('language-mermaid')).toBeNull();
    expect(languageFromMarkdownClassName(undefined)).toBeNull();
  });
});

it('avoids auto detection and expensive grammars above the input budget', () => {
  const auto = vi.spyOn(hljs, 'highlightAuto'); const explicit = vi.spyOn(hljs, 'highlight');
  expect(highlightMarkdownCode({ code: '<x>', language: 'unknown-language' }).__html).toBe('&lt;x&gt;');
  expect(highlightMarkdownCode({ code: '<x>', language: null }).__html).toBe('&lt;x&gt;');
  expect(highlightMarkdownCode({ code: '<'.repeat(16001), language: 'js' }).__html).toBe('&lt;'.repeat(16001));
  expect(auto).not.toHaveBeenCalled(); expect(explicit).not.toHaveBeenCalled(); auto.mockRestore(); explicit.mockRestore();
});
it('escapes text when a recognized grammar fails', () => {
  const spy = vi.spyOn(hljs, 'highlight').mockImplementationOnce(() => { throw Error('bad grammar'); });
  expect(highlightMarkdownCode({ code: '<broken>', language: 'js' }).__html).toBe('&lt;broken&gt;'); spy.mockRestore();
});
