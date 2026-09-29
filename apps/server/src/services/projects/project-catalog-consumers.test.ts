import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project } from '@zana-ai/zcc-domain/product';
import type { ProjectCatalogSource } from '@zana-ai/zcc-contracts/project-metadata-records';
import { localMetadataProjects } from './project-metadata.js';
const home = mkdtempSync(join(tmpdir(), 'project-catalog-consumers-'));
vi.mock('electron', () => ({ app: { getPath: () => home }, shell: { openPath: vi.fn() } }));
import { PersonaStore } from '../agents/persona-store.js';
import { TeamStore } from '../agents/team-store.js';
import { TemplateStore } from '../library/template-store.js';
afterEach(() => rmSync(home, { recursive: true, force: true }));

it('all catalogue consumers validate remote records, stamp ownership and never read a same-named local directory', () => {
  const root = join(home, 'foreign'), project: Project = { id: 'p', name: 'Original project', path: root, hostId: 'foreign', createdAt: 1, lastActiveAt: 1 };
  const values = [{ id: 'persona', name: 'Owner persona', model: 'sonnet', source: 'user' }, { id: 'team', name: 'Owner team', slots: [], source: 'builtin' }, { id: 'template', name: 'Owner template', defaults: { profile: 'shell', every: '1h', prompt: 'test' }, source: 'builtin' }];
  const kinds = ['personas', 'teams', 'templates'];
  const sources: ProjectCatalogSource[][] = values.map(value => [{ projectId: 'p', projectName: 'Original project', records: [JSON.stringify(value), 'not JSON', '{}'] }]);
  const local = () => localMetadataProjects([project], 'primary');
  const stores = [new PersonaStore(local, undefined, () => sources[0]), new TeamStore(local, undefined, () => sources[1]), new TemplateStore(local, () => sources[2])];
  for (const [index, kind] of kinds.entries()) {
    mkdirSync(join(root, '.zcc', kind), { recursive: true });
    writeFileSync(join(root, '.zcc', kind, 'shadow.json'), JSON.stringify({ ...values[index], id: 'local-shadow', name: 'Must never load' }));
  }
  try {
    for (const [index, store] of stores.entries()) {
      store.start();
      expect(store.list().find(row => row.id === 'local-shadow')).toBeUndefined();
      expect(store.list().find(row => row.id === values[index].id)).toMatchObject({ name: values[index].name, source: { projectId: 'p', projectName: 'Original project' } });
      sources[index] = []; store.rebindProjects(); expect(store.list().find(row => row.id === values[index].id)).toBeUndefined();
    }
  } finally { stores.forEach(store => store.stop()); }
});

it('preserves project precedence across local and remote metadata owners and registry reordering', () => {
  const project: Project = { id: 'local', name: 'Local', path: join(home, 'local'), createdAt: 1, lastActiveAt: 1 };
  const values = [
    { id: 'shared-persona', name: 'Local persona', model: 'sonnet' },
    { id: 'shared-team', name: 'Local team', slots: [] },
    { id: 'shared-template', name: 'Local template', defaults: { profile: 'shell', every: '1h', prompt: 'test' } }
  ];
  const kinds = ['personas', 'teams', 'templates'];
  const sources = values.map(value => [{ projectId: 'remote', projectName: 'Remote', records: [JSON.stringify({ ...value, name: 'Remote definition' })] }]);
  let order = ['remote', 'local'];
  const stores = [new PersonaStore(() => [project], undefined, () => sources[0], () => order), new TeamStore(() => [project], undefined, () => sources[1], () => order), new TemplateStore(() => [project], () => sources[2], () => order)];
  for (const [index, kind] of kinds.entries()) {
    const dir = join(project.path, '.zcc', kind); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'definition.json'), JSON.stringify(values[index]));
  }
  try {
    stores.forEach(store => store.start());
    for (const [index, store] of stores.entries()) expect(store.list().find(row => row.id === values[index].id)).toMatchObject({ name: values[index].name, source: { projectId: 'local' } });
    order = ['local', 'remote']; stores.forEach(store => store.refresh());
    for (const [index, store] of stores.entries()) expect(store.list().find(row => row.id === values[index].id)).toMatchObject({ name: 'Remote definition', source: { projectId: 'remote' } });
    order = ['local']; stores.forEach(store => store.refresh());
    for (const [index, store] of stores.entries()) expect(store.list().find(row => row.id === values[index].id)).toMatchObject({ name: values[index].name, source: { projectId: 'local' } });
  } finally { stores.forEach(store => store.stop()); }
});
