import { afterEach, expect, it, vi } from 'vitest';
const { connect, request, kill } = vi.hoisted(() => ({ connect: vi.fn(), request: vi.fn(), kill: vi.fn() }));
vi.mock('../packages/provider-bridge-acp/src/bridge/agent-connection.js', () => ({ createAcpAgentConnection: connect }));
import { actualOpenCodeModeLabels } from '../e2e/sdk/actual-acp-modes.js';
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });
function connection() { connect.mockReturnValue({ request, kill }); request.mockResolvedValueOnce({ protocolVersion: 1 }); }

it('reads actual advertised modes without a prompt, rejects client requests and releases the connection', async () => {
  connection(); request.mockResolvedValueOnce({ configOptions: [{ id: 'session-mode', category: 'mode', options: [
    { value: 'build', name: 'build' }, { value: 'plan' }, { value: 'reviewer', name: 'Review' }, { value: 'custom' },
  ] }] });
  expect(await actualOpenCodeModeLabels('/project')).toEqual(['Agent', 'Plan', 'Review', 'custom']);
  expect(request.mock.calls.map(([row]) => row.method)).toEqual(['initialize', 'session/new']);
  expect(request.mock.calls[1][0].params).toEqual({ cwd: '/project', mcpServers: [] });
  const options = connect.mock.calls[0][0], error = vi.fn();
  options.onNotification('ignored', {}); options.onExit({}); options.onRequest('write-file', {}, { error });
  expect(error).toHaveBeenCalledWith(-32601, expect.any(String)); expect(kill).toHaveBeenCalledOnce();
});
it('fails visibly when modes are absent or the CLI request fails', async () => {
  connection(); request.mockResolvedValueOnce({ configOptions: [{ id: 'mode', options: [] }] });
  await expect(actualOpenCodeModeLabels('/project')).rejects.toThrow('did not advertise');
  expect(kill).toHaveBeenCalledOnce();
  request.mockRejectedValueOnce(new Error('CLI exited'));
  await expect(actualOpenCodeModeLabels('/project')).rejects.toThrow('CLI exited'); expect(kill).toHaveBeenCalledTimes(2);
});
it('bounds a stuck installed CLI and closes it on timeout', async () => {
  vi.useFakeTimers(); connection(); request.mockReturnValueOnce(new Promise(() => {}));
  const probe = actualOpenCodeModeLabels('/project'), rejected = expect(probe).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(30_000); await rejected;
  expect(kill).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
