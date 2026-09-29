import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// BB keeps node-pty native and external. The join artifact embeds the same
// pinned package's JS and portable prebuilds, then loads it as an external
// package in a private directory. Never copy build/Release (local ABI output).
export function packedPtyFiles() {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve('node-pty/package.json'));
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const files = [];
  const add = (path, bytes) => files.push({ path, base64: bytes.toString('base64') });
  add('package.json', Buffer.from(JSON.stringify({ name: pkg.name, version: pkg.version, main: './lib/index.js', license: pkg.license })));
  add('LICENSE', readFileSync(join(root, 'LICENSE')));
  function collect(path) {
    for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
      const next = `${path}/${entry.name}`;
      if (entry.isDirectory()) collect(next);
      else if (entry.isFile() && (path.startsWith('lib') ? entry.name.endsWith('.js') && !entry.name.endsWith('.test.js') : /(?:\.node|\.dll|\.exe)$/.test(entry.name) || entry.name === 'spawn-helper')) add(next, readFileSync(join(root, next)));
    }
  }
  collect('lib');
  collect('prebuilds');
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
