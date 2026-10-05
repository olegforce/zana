import { Worker } from 'node:worker_threads';
import type { SearchHit } from '@zana-ai/zcc-domain/product';

const MAX_WORKERS = 2;
let activeWorkers = 0;
export const REGEX_FILE_TIMEOUT_MS = 500;

// Static, self-contained source survives bundling into Electron main/utility.
// The worker has no filesystem authority; it only receives a bounded file body.
const source = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', ({ text, pattern, flags }) => {
  try {
    const re = new RegExp(pattern, flags);
    const hits = [];
    const lines = text.split('\\n');
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      const m = re.exec(lines[i]);
      if (!m) continue;
      hits.push({ line: i + 1, column: m.index + 1, match: m[0].slice(0, 240),
        preview: lines[i].length > 240 ? lines[i].slice(0, 240) + '…' : lines[i] });
      if (hits.length === 20) break;
    }
    parentPort.postMessage({ hits });
  } catch { parentPort.postMessage({ error: 'Invalid search expression' }); }
});`;

type LineHit = Omit<SearchHit, 'path' | 'rel'>;
export function createRegexScanner() {
  if (activeWorkers >= MAX_WORKERS) return null;
  let worker: Worker;
  try { worker = new Worker(source, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 32, stackSizeMb: 2 } }); }
  catch { return null; }
  activeWorkers++;
  let stopped = false;
  let pending: { resolve(hits: LineHit[]): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | undefined;
  const fail = (error: Error) => {
    if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = undefined; }
  };
  const dispose = () => {
    if (stopped) return;
    stopped = true;
    fail(new Error('Search cancelled'));
    // Hold the slot until the thread really exits, including a timed-out regex.
    void worker.terminate();
  };
  worker.on('message', (result: { hits?: LineHit[]; error?: string }) => {
    if (!pending) return;
    const task = pending; pending = undefined; clearTimeout(task.timer);
    if (result.error) task.reject(new Error(result.error)); else task.resolve(result.hits ?? []);
  });
  worker.on('error', error => { fail(error instanceof Error ? error : new Error(String(error))); dispose(); });
  worker.on('exit', () => { activeWorkers--; stopped = true; fail(new Error('Search worker stopped')); });
  return {
    scan(text: string, pattern: string, flags: string): Promise<LineHit[]> {
      if (stopped || pending) return Promise.reject(new Error('Search worker unavailable'));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { fail(new Error('Search expression exceeded its time limit')); dispose(); }, REGEX_FILE_TIMEOUT_MS);
        pending = { resolve, reject, timer };
        try { worker.postMessage({ text, pattern, flags }); } catch (error) { fail(error as Error); dispose(); }
      });
    }, dispose
  };
}
