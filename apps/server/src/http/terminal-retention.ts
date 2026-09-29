import type { ProductTerminalRecord } from './product-context.js';
export const MAX_ACTIVE_PRODUCT_TERMINALS = 128;
export const MAX_RETAINED_PRODUCT_TERMINALS = 256;
/** Reserve before dispatch. Never evict live process ownership to make room. */
export function registerProductTerminal(records: Map<string, ProductTerminalRecord>, record: ProductTerminalRecord): void {
  if (records.has(record.id)) throw new Error('Terminal is already registered');
  let active = 0;
  for (const row of records.values()) if (row.status !== 'exited') active++;
  if (active >= MAX_ACTIVE_PRODUCT_TERMINALS) throw Object.assign(new Error('Close a running terminal before starting another'), { status: 429, code: 'terminal-limit' });
  const closed = [...records.values()].filter(row => row.status === 'exited').sort((a, b) => (a.finishedAt ?? a.createdAt) - (b.finishedAt ?? b.createdAt));
  for (const row of closed) {
    if (records.size < MAX_RETAINED_PRODUCT_TERMINALS) break;
    records.delete(row.id);
  }
  records.set(record.id, record);
}
