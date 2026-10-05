import { describe, it, expect, vi } from 'vitest';
import hljs from 'highlight.js/lib/common';
import { languageForPath, highlightForPath, highlightDiff } from '../highlightCode.js';

describe('languageForPath', () => {
  it('maps common code extensions to highlight.js languages', () => {
    expect(languageForPath('src/renderer/CuPanel.tsx')).toBe('typescript');
    expect(languageForPath('a/b/c.ts')).toBe('typescript');
    expect(languageForPath('script.js')).toBe('javascript');
    expect(languageForPath('component.jsx')).toBe('javascript');
    expect(languageForPath('data.json')).toBe('json');
    expect(languageForPath('main.py')).toBe('python');
    expect(languageForPath('run.sh')).toBe('bash');
    expect(languageForPath('conf.yaml')).toBe('yaml');
    expect(languageForPath('styles.css')).toBe('css');
  });

  it('is case-insensitive on the extension', () => {
    expect(languageForPath('FOO.TS')).toBe('typescript');
    expect(languageForPath('Data.JSON')).toBe('json');
  });

  it('handles backslash (Windows) path separators', () => {
    expect(languageForPath('src\\renderer\\CuPanel.tsx')).toBe('typescript');
  });

  it('maps known bare filenames', () => {
    expect(languageForPath('Dockerfile')).toBe('bash');
    expect(languageForPath('path/to/Makefile')).toBe('makefile');
  });

  it('returns null for markdown (rendered separately)', () => {
    // .md isn't in the map at all — DocContent routes it to MarkdownContent
    // before highlightForPath is ever consulted.
    expect(languageForPath('README.md')).toBeNull();
    expect(languageForPath('notes.markdown')).toBeNull();
  });

  it('returns null for unknown / extensionless paths', () => {
    expect(languageForPath('mystery.qwerty')).toBeNull();
    expect(languageForPath('LICENSE')).toBeNull();
    expect(languageForPath('')).toBeNull();
  });
});

describe('highlightForPath', () => {
  it('avoids grammar execution above the content budget', () => {
    const spy = vi.spyOn(hljs, 'highlight');
    try {
      expect(highlightForPath('a.ts', 'x'.repeat(16_001))).toBeNull();
      expect(highlightDiff('+x'.repeat(16_001))).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it('returns plain text when a grammar throws or is unavailable', () => {
    const spy = vi.spyOn(hljs, 'highlight').mockImplementation(() => { throw Error('grammar failure'); });
    try {
      expect(highlightForPath('a.ts', 'const x = 1;')).toBeNull();
      expect(highlightDiff('+const x = 1;')).toBeNull();
    } finally { spy.mockRestore(); }
    const missing = vi.spyOn(hljs, 'getLanguage').mockReturnValue(undefined);
    try { expect(highlightDiff('+x')).toBeNull(); } finally { missing.mockRestore(); }
  });

  it('highlights a bounded unified diff with escaped source', () => {
    const html = highlightDiff('@@ -1 +1 @@\n-old\n+<new>\n');
    expect(html).toContain('hljs-addition');
    expect(html).toContain('&lt;new&gt;');
  });
  it('returns language-tagged HTML for a known language', () => {
    const out = highlightForPath('a.ts', 'const x: number = 1;');
    expect(out).not.toBeNull();
    expect(out!.language).toBe('typescript');
    expect(out!.html).toContain('hljs-');
  });

  it('escapes HTML metacharacters in the source', () => {
    const out = highlightForPath('a.tsx', 'const el = <div>{"a < b"}</div>;');
    expect(out).not.toBeNull();
    // No raw unescaped angle bracket from the source survives as markup.
    expect(out!.html).not.toContain('<div>');
    expect(out!.html).toContain('&lt;');
  });

  it('returns null for unmapped paths so the caller renders plain text', () => {
    expect(highlightForPath('LICENSE', 'plain text')).toBeNull();
    expect(highlightForPath('x.unknownext', 'whatever')).toBeNull();
  });
});
