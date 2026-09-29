import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, launchApp } from './fixtures/app.js';

test('native discovery and MCP toggles never use a foreign project’s same-named local directory', async ({ home }) => {
  const local = join(home, 'local'), foreign = join(home, 'foreign-shadow');
  for (const [root, name] of [[local, 'local-canary'], [foreign, 'foreign-canary']]) {
    mkdirSync(join(root, '.claude/skills', name), { recursive: true });
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { [name]: { command: 'node', args: [] } } }));
    writeFileSync(join(root, '.claude/settings.local.json'), JSON.stringify({ canary: name }));
    writeFileSync(join(root, '.claude/skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Test local discovery\n---\nA test skill.\n`);
  }
  mkdirSync(join(home, '.zcc'), { recursive: true });
  writeFileSync(join(home, '.zcc/projects.json'), JSON.stringify({ version: 1, projects: [
    { id: 'local', name: 'Local', path: local, createdAt: 1, lastActiveAt: 1 },
    { id: 'foreign', name: 'Foreign', path: foreign, hostId: 'offline-other-machine', createdAt: 1, lastActiveAt: 1 },
  ] }));
  const canaryPath = join(foreign, '.claude/settings.local.json'), original = readFileSync(canaryPath, 'utf8');
  const app = await launchApp(home);
  try {
    expect((await app.window.evaluate(() => window.cc.projects.list())).find(project => project.id === 'foreign')?.hostId).toBe('offline-other-machine');
    const catalogs = await app.window.evaluate(async ({ local, foreign }) => ({
      local: await window.cc.mcp.list(local), foreign: await window.cc.mcp.list(foreign),
      all: await window.cc.mcp.listAll(), foreignSkills: await window.cc.skills.list(foreign),
    }), { local, foreign });
    expect(catalogs.local.some(row => row.name === 'local-canary')).toBe(true);
    expect(catalogs.foreign).toEqual([]); expect(catalogs.foreignSkills).toEqual([]);
    expect(catalogs.all.some(row => row.projectId === 'foreign')).toBe(false);
    await app.window.evaluate(async ({ local, foreign }) => {
      await window.cc.projects.touch('foreign');
      await window.cc.mcp.setEnabled(foreign, 'foreign-canary', false);
      await window.cc.mcp.setEnabled(local, 'local-canary', false);
    }, { local, foreign });
    expect(readFileSync(canaryPath, 'utf8')).toBe(original);
    expect(JSON.parse(readFileSync(join(local, '.claude/settings.local.json'), 'utf8')).mcpServers['local-canary'].disabled).toBe(true);
  } finally { await app.electron.close(); }
});
