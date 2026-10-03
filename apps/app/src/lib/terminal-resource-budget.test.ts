import { expect, it, vi } from 'vitest';
import { createVisibleTerminalRenderer, terminalScrollbackBudget, TERMINAL_SCROLLBACK_TOTAL } from './terminal-resource-budget.js';

it.each([[1, 50000], [16, 12500], [64, 3125], [128, 1562]])('bounds retained history for %i sessions', (count, expected) => {
  expect(terminalScrollbackBudget(count)).toBe(expected);
  expect(count * terminalScrollbackBudget(count)).toBeLessThanOrEqual(TERMINAL_SCROLLBACK_TOTAL);
});
it('keeps a useful allocation before the first session', () => expect(terminalScrollbackBudget(0)).toBe(50000));
it('allocates only visible renderers and releases GPU/listeners while preserving terminal buffers', () => {
  const load = vi.fn(); const dispose = vi.fn(); const off = vi.fn();
  const create = vi.fn(() => ({ dispose, onContextLoss: () => ({ dispose: off }) }));
  const renderer = createVisibleTerminalRenderer(load, create);
  renderer.setVisible(false); expect(create).not.toHaveBeenCalled();
  renderer.setVisible(true); renderer.setVisible(true); expect(create).toHaveBeenCalledTimes(1);
  renderer.setVisible(false); expect(dispose).toHaveBeenCalledTimes(1); expect(off).toHaveBeenCalledTimes(1);
  renderer.setVisible(true); expect(create).toHaveBeenCalledTimes(2);
  renderer.dispose(); renderer.setVisible(true); expect(create).toHaveBeenCalledTimes(2); expect(dispose).toHaveBeenCalledTimes(2);
});
it('falls back on context loss and cleans up failed attachment without retries', () => {
  let lost = () => {};
  const dispose = vi.fn(); const off = vi.fn();
  const create = vi.fn(() => ({ dispose, onContextLoss: (listener: () => void) => { lost = listener; return { dispose: off }; } }));
  const renderer = createVisibleTerminalRenderer(() => {}, create);
  renderer.setVisible(true); lost(); renderer.setVisible(true); renderer.dispose();
  expect(create).toHaveBeenCalledTimes(1); expect(dispose).toHaveBeenCalledTimes(1); expect(off).toHaveBeenCalledTimes(1);
  const failed = createVisibleTerminalRenderer(() => { throw new Error('no GPU'); }, create);
  failed.setVisible(true); failed.setVisible(true); failed.dispose();
  expect(create).toHaveBeenCalledTimes(2); expect(dispose).toHaveBeenCalledTimes(2);
});
it('handles a constructor failure and an already lost context on disposal', () => {
  const create = vi.fn(() => { throw new Error('GPU blocklisted'); });
  const renderer = createVisibleTerminalRenderer(() => {}, create);
  renderer.setVisible(true); renderer.setVisible(true); renderer.dispose();
  expect(create).toHaveBeenCalledTimes(1);
  const lost = createVisibleTerminalRenderer(() => {}, () => ({ onContextLoss: () => ({ dispose() {} }), dispose() { throw new Error('lost'); } }));
  lost.setVisible(true); expect(() => lost.dispose()).not.toThrow();
});
