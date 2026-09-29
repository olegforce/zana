import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
function installed(name: string) {
  const root = resolve('node_modules/.pnpm');
  const entries = readdirSync(root).filter(p => p.startsWith(`${name}@`) && (name !== 'decode-uri-component' || p.includes('patch_hash=')));
  if (!entries.length) throw new Error(`Missing ${name}`);
  return entries.map(p => require(resolve(root, p, 'node_modules', name)));
}
describe('dependency security compatibility', () => {
  it('keeps Monaco HTML sanitization and explicit forbidden tags effective', () => {
    const monaco = realpathSync(resolve('apps/app/node_modules/monaco-editor/package.json'));
    const purify = createRequire(monaco)('dompurify');
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('');
    try {
      const sanitizer = purify(dom.window);
      expect(sanitizer.sanitize('<img src=x onerror=alert(1)><script>alert(1)</script>')).toBe('<img src="x">');
      expect(sanitizer.sanitize('<custom-tag>safe</custom-tag>', { ADD_TAGS: () => true, FORBID_TAGS: ['custom-tag'] })).toBe('safe');
    } finally { dom.window.close(); }
  });

  it('bounds malformed percent decoding and retains CommonJS/plus handling', () => {
    for (const decode of installed('decode-uri-component')) {
      const start = performance.now();
      expect(decode('%C0'.repeat(10_000))).toBe('%C0'.repeat(10_000));
      expect(performance.now() - start).toBeLessThan(1000);
      expect(decode('hello+world%20%C3%A9')).toBe('hello world é');
      expect(decode('%FE%FF')).toBe('\uFFFD\uFFFD');
      expect(() => decode(12)).toThrow(TypeError);
    }
  });
  it('keeps Expo xcode UUID generation working with the patched uuid release', () => {
    for (const xcode of installed('xcode')) {
      const project = xcode.project('/tmp/test.pbxproj');
      project.hash = { project: { objects: {} } };
      expect(project.generateUuid()).toMatch(/^[A-F0-9]{24}$/);
    }
  });
});
