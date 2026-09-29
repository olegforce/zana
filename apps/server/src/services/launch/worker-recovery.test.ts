import { expect, it } from 'vitest';
import type { Project } from '@zana-ai/zcc-domain/product';
import type { LaunchLedgerEntry } from './ledger-store.js';
import { projectIdentityDigest } from './commit-revalidation.js';
import { workerRecoveryEvidence } from './worker-recovery.js';

const project = { id: 'project', path: '/owner/project', name: 'Project', createdAt: 1, lastActiveAt: 1 } as Project;
const principal = { kind: 'automation' as const, id: 'goal:one' };
const entry = { id: 'entry', sessionId: 'worker', state: 'interrupted', recoveryEvidence: 'not-started', principal,
  binding: { consumerKind: 'terminal', projectIdentityDigest: projectIdentityDigest(project) } } as LaunchLedgerEntry;
const inspect = (entries: LaunchLedgerEntry[], owner: Project | undefined = project) => workerRecoveryEvidence(entries, owner, 'worker', principal);
it('accepts only durable no-spawn and exit evidence for the exact reservation', () => {
  expect(inspect([entry])).toBe('not-started');
  expect(inspect([{ ...entry, state: 'denied', recoveryEvidence: undefined }])).toBe('not-started');
  expect(inspect([{ ...entry, state: 'exited', recoveryEvidence: undefined }])).toBe('exited');
  expect(inspect([entry], { ...project, lastActiveAt: 90 })).toBe('not-started');
});
it.each(['authorized', 'committing', 'launched', 'failed', 'interrupted'] as const)('keeps %s without proof ambiguous', state => {
  expect(inspect([{ ...entry, state, recoveryEvidence: undefined }])).toBe('unknown');
});
it('rejects missing, duplicate, mismatched and legacy evidence', () => {
  for (const entries of [[], [entry, entry], [{ ...entry, sessionId: 'other' }], [{ ...entry, principal: undefined }],
    [{ ...entry, principal: { kind: 'schedule' as const, id: principal.id } }], [{ ...entry, principal: { ...principal, id: 'goal:other' } }],
    [{ ...entry, binding: undefined }], [{ ...entry, binding: { ...entry.binding!, consumerKind: 'team-slot' as const } }]]) expect(inspect(entries)).toBe('unknown');
  expect(workerRecoveryEvidence([entry], undefined, 'worker', principal)).toBe('unknown');
  expect(inspect([entry], { ...project, path: '/different' })).toBe('unknown');
});
