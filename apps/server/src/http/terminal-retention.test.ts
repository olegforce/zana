import { expect, it } from 'vitest';
import { registerProductTerminal, MAX_ACTIVE_PRODUCT_TERMINALS, MAX_RETAINED_PRODUCT_TERMINALS } from './terminal-retention.js';
import type { ProductTerminalRecord } from './product-context.js';
const row = (id: string, status: 'running' | 'exited' = 'running', createdAt = 1): ProductTerminalRecord => ({ id, projectId: 'p', hostId: 'h', title: id, profile: 'shell', cwd: '/repo', status, createdAt });
it('evicts oldest completed output while preserving active terminals', () => {
  const records = new Map<string, ProductTerminalRecord>();
  records.set('running', row('running'));
  for (let i = 0; i < MAX_RETAINED_PRODUCT_TERMINALS - 1; i++) records.set(`old-${i}`, { ...row(`old-${i}`, 'exited', i + 1), ...(i === 0 ? { finishedAt: 1000 } : {}) });
  registerProductTerminal(records, row('new'));
  expect(records.size).toBe(MAX_RETAINED_PRODUCT_TERMINALS);
  expect(records.has('running')).toBe(true); expect(records.has('old-0')).toBe(true); expect(records.has('old-1')).toBe(false);
});
it('rejects a full live set and duplicate ids before overwriting ownership', () => {
  const records = new Map<string, ProductTerminalRecord>();
  for (let i = 0; i < MAX_ACTIVE_PRODUCT_TERMINALS; i++) registerProductTerminal(records, row(`live-${i}`));
  expect(() => registerProductTerminal(records, row('new'))).toThrow('Close');
  expect(() => registerProductTerminal(records, row('live-0'))).toThrow('already');
  expect(records.size).toBe(MAX_ACTIVE_PRODUCT_TERMINALS);
});
