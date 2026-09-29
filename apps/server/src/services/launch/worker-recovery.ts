import type { Project } from '@zana-ai/zcc-domain/product';
import type { LaunchLedgerEntry } from './ledger-store.js';
import type { LaunchPrincipalRef } from './types.js';
import { projectIdentityDigest } from './commit-revalidation.js';

export type WorkerRecoveryEvidence = 'not-started' | 'exited' | 'unknown';
export type InspectWorkerLaunch = (projectId: string, sessionId: string, principal: LaunchPrincipalRef) => Promise<WorkerRecoveryEvidence>;

/** Absence from inventory is not evidence of termination. Only a matching,
 * durable launch decision or observed exit can release a pending reservation.
 * In particular, failed/interrupted spawns may still own a live process.
 */
export function workerRecoveryEvidence(entries: readonly LaunchLedgerEntry[], project: Project | undefined,
  sessionId: string, principal: LaunchPrincipalRef): WorkerRecoveryEvidence {
  if (!project) return 'unknown';
  const matches = entries.filter(entry => entry.sessionId === sessionId);
  if (matches.length !== 1) return 'unknown';
  const entry = matches[0];
  if (entry.principal?.kind !== principal.kind || entry.principal.id !== principal.id
    || entry.binding?.consumerKind !== 'terminal' || entry.binding.projectIdentityDigest !== projectIdentityDigest(project)) return 'unknown';
  if (entry.state === 'exited') return 'exited';
  if (entry.state === 'denied' || (entry.state === 'interrupted' && entry.recoveryEvidence === 'not-started')) return 'not-started';
  return 'unknown';
}
