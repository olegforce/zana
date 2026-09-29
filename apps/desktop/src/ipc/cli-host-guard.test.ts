import { expect, it } from 'vitest';
import { cliHostProblem, teamHostProblem } from './cli-host-guard.js';
it('preserves default and explicitly primary launches', () => {
  expect(cliHostProblem({}, undefined)).toBeUndefined();
  expect(cliHostProblem({}, {})).toBeUndefined();
  expect(cliHostProblem({ hostId: 'primary' }, {}, 'primary')).toBeUndefined();
  expect(cliHostProblem({}, { hostId: 'primary' }, 'primary')).toBeUndefined();
});
it('keeps primary and legacy Team projects launchable, and rejects secondary or unresolved owners', () => {
  expect(teamHostProblem({})).toBeUndefined();
  expect(teamHostProblem({}, 'primary')).toBeUndefined();
  expect(teamHostProblem({ hostId: 'primary' }, 'primary')).toBeUndefined();
  expect(teamHostProblem({ hostId: 'remote' }, 'primary')).toContain('Squad/Team');
  expect(teamHostProblem({ hostId: 'primary' })).toContain('primary machine');
});
it('rejects remote or unknown identities before a local filesystem or process can be touched', () => {
  for (const [request, project, local] of [
    [{ hostId: 'remote' }, {}, 'primary'], [{}, { hostId: 'remote' }, 'primary'],
    [{ hostId: 'primary' }, { hostId: 'remote' }, 'primary'], [{ hostId: 'primary' }, {}, undefined],
    [{ hostId: '' }, {}, 'primary'], [{ hostId: 42 }, {}, 'primary']
  ] as const) expect(cliHostProblem(request as any, project, local)).toBeTruthy();
});
