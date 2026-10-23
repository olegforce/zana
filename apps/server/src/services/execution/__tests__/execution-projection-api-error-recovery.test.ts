import { describe, expect, it } from 'vitest';
import { projectExecutionProjection } from '../projection.js';
import type { ExecutionRecord, ExecutionWorkUnit } from '../store.js';

function record(unit: Partial<ExecutionWorkUnit>): ExecutionRecord {
  return {
    id: 'execution-1', callerPrincipalId: 'owner', projectId: 'project-1', launchKind: 'team', jobTitle: 'Job', requestDigest: 'd',
    launchRequestId: 'r', teamLaunchRequestId: 't', request: { version: 1, launchKind: 'team', slots: [{ initialTask: 'x' }], resolvedModels: [] },
    attempt: 1, state: 'RUNNING', stateVersion: 1, resolvedModels: [], createdAt: 1, updatedAt: 2,
    workUnits: [{
      id: 'unit', title: 'Unit', task: 'Work', dependencies: [], state: 'CLAIMED', assignedSlotId: 'slot-1', claimId: 'c1', claimGeneration: 1, attempt: 1, history: [],
      apiErrorRecovery: { claimId: 'c1', claimGeneration: 1, slotId: 'slot-1', executionAttempt: 1, step: 'nudged', errorKind: 'overloaded', startedAt: 50, updatedAt: 60, steps: [{ step: 'nudged', at: 60 }] },
      ...unit
    }]
  } as ExecutionRecord;
}

const assignment = (input: ExecutionRecord) => projectExecutionProjection([input], [])[0].work!.assignments[0];

describe('work projection recovery', () => {
  it('shows recovery only while it is active', () => {
    expect(assignment(record({}))).toMatchObject({ recovery: { step: 'nudged', errorKind: 'overloaded', since: 50 } });
    expect(assignment(record({ claimGeneration: 2 }))).not.toHaveProperty('recovery');
    expect(assignment(record({ state: 'READY', claimId: undefined }))).not.toHaveProperty('recovery');
    const done = record({});
    done.workUnits![0].apiErrorRecovery!.step = 'exhausted';
    expect(assignment(done)).not.toHaveProperty('recovery');
    expect(assignment(record({ apiErrorRecovery: undefined }))).not.toHaveProperty('recovery');
  });

  it('omits errorKind when none was recorded', () => {
    const input = record({});
    delete input.workUnits![0].apiErrorRecovery!.errorKind;
    expect(assignment(input).recovery).toEqual({ step: 'nudged', since: 50 });
  });
});
