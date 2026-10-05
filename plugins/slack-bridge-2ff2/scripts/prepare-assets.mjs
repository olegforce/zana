import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assets = new URL('../assets/', import.meta.url);
await mkdir(assets, { recursive: true });
await copyFile(require.resolve('mermaid/dist/mermaid.min.js'), new URL('mermaid.min.js', assets));
