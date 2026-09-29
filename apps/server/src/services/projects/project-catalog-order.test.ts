import { expect, it } from 'vitest';
import type { Project } from '@zana-ai/zcc-domain/product';
import { orderedCatalogSources } from './project-catalog-order.js';

it('orders registered sources without promoting order entries into paths or duplicating owners', () => {
  const project = { id: 'local', path: '/allowed' } as Project;
  const source = { projectId: 'remote', projectName: 'Remote', records: [] };
  const staleLocal = { ...source, projectId: 'local' };
  const local = { kind: 'local', project }, remote = { kind: 'remote', source };
  expect(orderedCatalogSources([project], [source, staleLocal])).toEqual([local, remote]);
  expect(orderedCatalogSources([project], [source], ['remote', '/arbitrary', 'local', 'remote'])).toEqual([remote, local]);
  expect(orderedCatalogSources([project], [source], ['local'])).toEqual([local]);
  expect(orderedCatalogSources([project], [source], [])).toEqual([]);
});
