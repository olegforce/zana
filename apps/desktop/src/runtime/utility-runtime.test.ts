import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUtilityRuntime } from './runtime-supervisor.js';
import { SERVER_RUNTIME_PROTOCOL_VERSION as protocolVersion } from '@zana-ai/zcc-contracts/runtime';
function fixture() {
  const child = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn(), pid: 42 });
  const gone = vi.fn();
  const runtime = createUtilityRuntime({ child, url: 'http://localhost/' }, gone);
  return { child, gone, runtime };
}
afterEach(() => vi.useRealTimers());
describe('utility process lifecycle', () => {
  it('rejects pending and future calls immediately after a crash', async () => {
    vi.useFakeTimers(); const { child, runtime, gone } = fixture();
    const first = runtime.request('projects-list');
    const rejected = expect(first).rejects.toThrow('exited');
    child.emit('exit', 9); await rejected;
    await expect(runtime.request('projects-list')).rejects.toThrow('Restart Zana');
    expect(gone).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
    await runtime.stop(); expect(child.postMessage).toHaveBeenCalledTimes(1);
  });
  it('cleans a rejected postMessage and times out an unresponsive child', async () => {
    vi.useFakeTimers(); const { child, runtime } = fixture();
    child.postMessage.mockImplementationOnce(() => { throw new Error('closed channel'); });
    await expect(runtime.request('projects-list')).rejects.toThrow('closed channel');
    expect(vi.getTimerCount()).toBe(0);
    const request = expect(runtime.request('projects-list')).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(20_000); await request; expect(vi.getTimerCount()).toBe(0);
  });
  it('resolves responses, ignores malformed messages and clears response timers', async () => {
    vi.useFakeTimers(); const { child, runtime } = fixture();
    const pending = runtime.request('projects-list');
    const { id } = child.postMessage.mock.calls[0]![0];
    child.emit('message', {}); child.emit('message', { type: 'result', protocolVersion, id: 'unknown', value: [] });
    child.emit('message', { type: 'result', protocolVersion, id, value: [{ id: 'project' }] });
    expect(await pending).toEqual([{ id: 'project' }]); expect(vi.getTimerCount()).toBe(0);
  });
  it.each([true, false])('does not report deliberate shutdown as a crash, graceful=%s', async graceful => {
    vi.useFakeTimers(); const { child, runtime, gone } = fixture();
    const stopped = runtime.stop();
    await expect(runtime.request('projects-list')).rejects.toThrow('Restart Zana');
    if (graceful) child.emit('message', { type: 'stopped', protocolVersion });
    else await vi.advanceTimersByTimeAsync(3000);
    await stopped; child.emit('exit', 0);
    expect(gone).not.toHaveBeenCalled(); expect(child.kill).toHaveBeenCalledTimes(graceful ? 0 : 1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
