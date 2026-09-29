import { expect, it } from 'vitest';
import { projectMetadataLocation, localMetadataProjects, localProjectPathOptions } from './project-metadata.js';
it('keeps metadata on the canonical source irrespective of execution checkouts', () => {
  const project = { path: '/canonical', hostId: 'owner', sources: [{ path: '/execution', hostId: 'worker' }] };
  expect(projectMetadataLocation(project)).toEqual({ path: '/canonical', hostId: 'owner' });
  expect(projectMetadataLocation({ path: '/legacy-primary' })).toEqual({ path: '/legacy-primary' });
  expect(() => projectMetadataLocation({ path: '/placeholder', remote: { host: 'legacy' } as any })).toThrow('legacy SSH project');
});

it('does not turn a remote, unknown or malformed discovery path into local or global access', () => {
  const projects = [{ id: 'legacy', path: '/legacy' }, { id: 'local', hostId: 'primary', path: '/local' },
    { id: 'foreign', hostId: 'foreign', path: '/foreign', sources: [{ hostId: 'primary', path: '/checkout' }] }] as any;
  expect(localProjectPathOptions(projects, 'primary')).toEqual({});
  expect(localProjectPathOptions(projects, 'primary', '/legacy')).toEqual({ projectId: 'legacy', projectPath: '/legacy' });
  expect(localProjectPathOptions(projects, 'primary', '/local')).toEqual({ projectId: 'local', projectPath: '/local' });
  for (const path of ['/foreign', '/checkout', '/unknown', '', null, {}]) {
    expect(() => localProjectPathOptions(projects, 'primary', path as any)).toThrow('on this machine');
  }
  expect(() => localProjectPathOptions(projects, undefined, '/local')).toThrow('on this machine');
});

it('never gives synchronous stores a foreign owner path, even with a local execution checkout', () => {
  const projects = [{ id: 'legacy', path: '/same' }, { id: 'primary', hostId: 'primary', path: '/same' },
    { id: 'foreign', hostId: 'foreign', path: '/same', sources: [{ hostId: 'primary', path: '/same' }] }] as any;
  expect(localMetadataProjects(projects, 'primary').map(p => p.id)).toEqual(['legacy', 'primary']);
  expect(localMetadataProjects(projects).map(p => p.id)).toEqual(['legacy']);
  expect(projects).toHaveLength(3);
});
