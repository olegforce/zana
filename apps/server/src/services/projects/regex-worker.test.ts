import { expect, it, vi } from 'vitest';
import { createRegexScanner } from './regex-worker.js';
it('matches patterns off-thread with bounded results and rejects invalid patterns', async () => {
  const scanner = createRegexScanner()!;
  try {
    const hits = await scanner.scan('before\nNEEDLE\n' + 'x'.repeat(300), 'needle|x+', 'gi');
    expect(hits[0]).toMatchObject({ line: 2, column: 1, match: 'NEEDLE' });
    expect(hits[1].preview.length).toBe(241); expect(hits[1].match.length).toBe(240);
    expect(await scanner.scan('x\n'.repeat(50), 'x', 'g')).toHaveLength(20);
    await expect(scanner.scan('x', '(', 'g')).rejects.toThrow('Invalid');
  } finally { scanner.dispose(); }
});
it('bounds concurrent workers and kills pathological matches while timers stay live', async () => {
  let scanner: ReturnType<typeof createRegexScanner>;
  await vi.waitFor(() => { scanner = createRegexScanner(); expect(scanner).not.toBeNull(); });
  let second: ReturnType<typeof createRegexScanner>;
  await vi.waitFor(() => { second = createRegexScanner(); expect(second).not.toBeNull(); });
  expect(createRegexScanner()).toBeNull();
  const ticks = vi.fn(), interval = setInterval(ticks, 10);
  try {
    await expect(scanner!.scan('a'.repeat(32) + '!', '(a+)+$', 'g')).rejects.toThrow('time limit');
    expect(ticks.mock.calls.length).toBeGreaterThan(5);
    await expect(scanner!.scan('x', 'x', 'g')).rejects.toThrow('unavailable');
    const pending = second!.scan('a'.repeat(32) + '!', '(a+)+$', 'g');
    await expect(second!.scan('x', 'x', 'g')).rejects.toThrow('unavailable');
    second!.dispose(); await expect(pending).rejects.toThrow('cancelled');
  } finally { clearInterval(interval); scanner!.dispose(); second!.dispose(); }
});
