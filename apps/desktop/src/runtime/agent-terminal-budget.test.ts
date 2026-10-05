import { expect, it, vi } from 'vitest';
import { createAgentTerminalBudget } from './agent-terminal-budget.js';
const success = (id: string): any => ({ ok: true, value: { id } });
it('reserves pending capacity before owner validation and releases failed reservations', async () => {
  const live = new Set<string>(), budget = createAgentTerminalBudget(id => live.has(id));
  const resolves: Array<(value: boolean) => void> = [];
  const validate = () => new Promise<boolean>(resolve => resolves.push(resolve));
  const create = vi.fn(async () => { const id = `s${create.mock.calls.length}`; live.add(id); return success(id); });
  const tasks = Array.from({ length: 6 }, () => budget.launch('owner', validate, create));
  resolves.forEach(resolve => resolve(true));
  const results = await Promise.all(tasks);
  expect(results.filter(result => result.ok)).toHaveLength(3);
  expect(create).toHaveBeenCalledTimes(3);
  expect(await budget.launch('owner', async () => true, create)).toMatchObject({ ok: false });
  live.clear();
  expect(await budget.launch('owner', async () => false, create)).toMatchObject({ ok: false });
  await expect(budget.launch('owner', async () => true, async () => { throw new Error('spawn'); })).rejects.toThrow('spawn');
  expect(await budget.launch('owner', async () => true, create)).toMatchObject({ ok: true });
});
it('rejects malformed owners and bounds the owner registry', async () => {
  const budget = createAgentTerminalBudget(() => true);
  const create = vi.fn(async () => success('s'));
  expect(await budget.launch('', async () => true, create)).toMatchObject({ ok: false });
  expect(await budget.launch('x'.repeat(129), async () => true, create)).toMatchObject({ ok: false });
  for (let i = 0; i < 128; i++) await budget.launch(`owner${i}`, async () => true, create);
  expect(await budget.launch('extra', async () => true, create)).toMatchObject({ ok: false });
  expect(create).toHaveBeenCalledTimes(128);
});
