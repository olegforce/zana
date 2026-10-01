// One authored catalog; generated copies keep hosted and path-installed builds self-contained.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
const source = await readFile(new URL('./catalog.json', import.meta.url), 'utf8');
const args = process.argv.slice(2);
const at = args.indexOf('--plugin');
const targets = [resolve(root, 'website/slack/capabilities.json')];
if (at !== -1 && args[at+1]) targets.push(resolve(args[at+1], 'src/capability-catalog.json'));
for (const target of targets) {
  if (args.includes('--check')) {
    if (await readFile(target, 'utf8') !== source) throw new Error(`Regenerate catalog: ${target}`);
  } else await writeFile(target, source);
}
console.log(`Slack capability catalog: ${targets.length} copies ${args.includes('--check') ? 'verified' : 'updated'}.`);
