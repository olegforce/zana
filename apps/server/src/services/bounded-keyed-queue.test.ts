import { expect, it } from 'vitest';
import { BoundedKeyedQueue } from './bounded-keyed-queue.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

it('reserves multiple owners atomically, including opposing transfers at capacity', async () => {
  const queue = new BoundedKeyedQueue(1, 10, 'full'), gate = deferred(), order: string[] = [];
  const a = queue.run('a', async () => { order.push('a'); await gate.promise; });
  const ab = queue.runMany(['a', 'b', 'a'], async () => { order.push('ab'); throw new Error('lost'); });
  const failed = expect(ab).rejects.toThrow('lost');
  const ba = queue.runMany(['b', 'a'], async () => { order.push('ba'); });
  const b = queue.run('b', async () => { order.push('b'); });
  gate.resolve(); await Promise.all([a, failed, ba, b]); expect(order).toEqual(['a', 'ab', 'ba', 'b']);
  await expect(queue.runMany([], async () => {})).rejects.toThrow('owner');
});

it('limits aggregate concurrency across distinct owners and releases all slots', async () => {
  const queue = new BoundedKeyedQueue(4, 100, 'full');
  const gates = Array.from({ length: 12 }, deferred);
  let active = 0, max = 0;
  const started: number[] = [];
  const tasks = gates.map((gate, index) => queue.run(`p${index}`, async () => {
    started.push(index); active++; max = Math.max(max, active);
    await gate.promise; active--; return index;
  }));
  await tick(); expect(started).toEqual([0, 1, 2, 3]);
  gates[2].resolve(); await tick(); expect(started).toEqual([0, 1, 2, 3, 4]);
  gates.forEach(gate => gate.resolve());
  expect(await Promise.all(tasks)).toEqual(Array.from({ length: 12 }, (_, i) => i));
  expect(max).toBe(4); expect(active).toBe(0);
  await expect(queue.run('p0', async () => 'reused')).resolves.toBe('reused');
});

it('serializes each owner and gives other owners a turn before its successor', async () => {
  const queue = new BoundedKeyedQueue(1, 5, 'full');
  const gate = deferred(), order: string[] = [];
  const first = queue.run('hot', async () => { order.push('hot1'); await gate.promise; });
  const second = queue.run('hot', async () => { order.push('hot2'); });
  const third = queue.run('cold', async () => { order.push('cold'); });
  await tick(); expect(order).toEqual(['hot1']);
  gate.resolve(); await Promise.all([first, second, third]);
  expect(order).toEqual(['hot1', 'cold', 'hot2']);
});

it('counts same-owner waiters toward capacity and recovers after failures', async () => {
  const queue = new BoundedKeyedQueue(1, 2, 'too much work');
  const gate = deferred();
  const first = queue.run('p', async () => { await gate.promise; throw new Error('host offline'); });
  const failure = expect(first).rejects.toThrow('host offline');
  const second = queue.run('p', async () => 'recovered');
  let invoked = false;
  await expect(queue.run('other', async () => { invoked = true; })).rejects.toThrow('too much work');
  expect(invoked).toBe(false);
  gate.resolve(); await failure; await expect(second).resolves.toBe('recovered');
  await expect(queue.run('other', async () => 'ok')).resolves.toBe('ok');
});

it.each([[0, 1], [-1, 5], [1.5, 3], [2, 1], [1, Infinity], [1, 1.5]])('rejects invalid limits %s/%s', (active, pending) => {
  expect(() => new BoundedKeyedQueue(active, pending, 'full')).toThrow('Invalid bounded queue limits');
});

it('bounds retained queued payloads as well as active I/O and restores the budget on failure', async () => {
  const queue = new BoundedKeyedQueue(1, 100, 'payload capacity reached', 10);
  const gate = deferred();
  const active = queue.run('p', async () => { await gate.promise; throw new Error('offline'); }, 6);
  const failed = expect(active).rejects.toThrow('offline');
  const queued = queue.run('p', async () => 4, 4);
  await expect(queue.run('q', async () => 1, 1)).rejects.toThrow('payload capacity reached');
  gate.resolve(); await failed; await expect(queued).resolves.toBe(4);
  await expect(queue.run('q', async () => 10, 10)).resolves.toBe(10);
  await expect(queue.run('q', async () => 11, 11)).rejects.toThrow('payload capacity reached');
});

it.each([-1, 1.5, Infinity])('rejects invalid payload accounting: %s', async size => {
  await expect(new BoundedKeyedQueue(1, 1, 'full').run('p', async () => 1, size)).rejects.toThrow('Invalid retained payload size');
});
it.each([0, -1, 1.5, Infinity])('rejects invalid byte budgets: %s', size => {
  expect(() => new BoundedKeyedQueue(1, 1, 'full', size)).toThrow('Invalid bounded queue limits');
});
