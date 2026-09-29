import { expect, it, vi, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'metadata-no-fallback-'));
vi.mock('../../electron-data-dir.js', () => ({ electronZccDataDir: () => root }));
afterAll(() => rmSync(root, { recursive: true, force: true }));
import { saveSchedule } from '../scheduler/scheduler-store.js';
import { saveGoal } from '../goals/goal-store.js';
import { saveFollowUp } from '../followups/followup-store.js';

it.each([['schedule', saveSchedule], ['goal', saveGoal], ['follow-up', saveFollowUp]] as const)('refuses to save %s metadata globally when its project owner is unavailable', (_name, save) => {
  expect(() => (save as Function)({ id: 'not-written', source: { projectId: 'foreign-owner' } }, [])).toThrow('no local or global fallback');
  for (const folder of ['schedules', 'goals', 'followups']) expect(existsSync(join(root, folder))).toBe(false);
});
