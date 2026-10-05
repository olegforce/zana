import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ failConstruct: false, worker: null as any }));
vi.mock('node:worker_threads', () => ({ Worker: class extends EventEmitter {
  postMessage = vi.fn();
  terminate = vi.fn(async () => { this.emit('exit', 0); });
  constructor() { super(); if (state.failConstruct) throw Error('worker unavailable'); state.worker = this; }
} }));
import { createRegexScanner } from './regex-worker.js';
afterEach(() => { state.failConstruct = false; });
it('fails closed when workers cannot start', () => {
  state.failConstruct = true; expect(createRegexScanner()).toBeNull();
});
it('rejects a failed post and releases the worker slot', async () => {
  const scanner = createRegexScanner()!; state.worker.postMessage.mockImplementation(() => { throw Error('closed port'); });
  await expect(scanner.scan('body', 'x', 'g')).rejects.toThrow('closed port');
  expect(state.worker.terminate).toHaveBeenCalledOnce();
});
it.each([new Error('worker failure'), 'worker failure'])('settles pending work after an error event %s', async failure => {
  const scanner = createRegexScanner()!, worker = state.worker;
  const pending = scanner.scan('body', 'x', 'g'); worker.emit('error', failure);
  await expect(pending).rejects.toThrow('worker failure'); expect(worker.terminate).toHaveBeenCalledOnce();
  worker.emit('message', { hits: [{ line: 1 }] });
});
it('tolerates empty and late replies without resettling a scan', async () => {
  const scanner = createRegexScanner()!, worker = state.worker;
  const pending = scanner.scan('body', 'x', 'g'); worker.emit('message', {});
  await expect(pending).resolves.toEqual([]); worker.emit('message', { error: 'late' }); scanner.dispose();
});
