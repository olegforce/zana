import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readEnvironment as readShared } from './tool-proxy-mcp.js';
import { readEnvironment as readPlugin } from '../../../../plugins/provider-acp/src/bridge/tool-proxy-mcp.js';

const keys = ['HOST', 'PORT', 'TOKEN', 'THREAD_ID', 'PROGRESS_INTERVAL_MS'];
const tools = JSON.stringify([{ name: 'Example', description: 'Example tool', inputSchema: { type: 'object' } }]);
function seed(prefix: 'ZCC' | 'BB') {
  for (const [key, value] of Object.entries({ HOST: '127.0.0.1', PORT: '1234', TOKEN: 'secret', THREAD_ID: 'thread' })) vi.stubEnv(`${prefix}_ACP_DYNAMIC_TOOL_${key}`, value);
  vi.stubEnv(`${prefix}_ACP_DYNAMIC_TOOLS`, tools);
}
beforeEach(() => {
  for (const prefix of ['ZCC', 'BB']) {
    for (const key of keys) vi.stubEnv(`${prefix}_ACP_DYNAMIC_TOOL_${key}`, undefined);
    vi.stubEnv(`${prefix}_ACP_DYNAMIC_TOOLS`, undefined);
  }
});
afterEach(() => vi.unstubAllEnvs());

describe.each([['shared', readShared], ['plugin', readPlugin]] as const)('%s dynamic MCP environment', (_name, read) => {
  it('accepts current keys and falls back to existing proxy configuration', () => {
    seed('BB');
    expect(read()).toMatchObject({ host: '127.0.0.1', port: 1234, threadId: 'thread', token: 'secret', tools: JSON.parse(tools) });
    seed('ZCC'); vi.stubEnv('ZCC_ACP_DYNAMIC_TOOL_TOKEN', 'current');
    expect(read().token).toBe('current');
  });
  it.each(['0', '-1', '1.5', 'bad', undefined])('rejects invalid port %s', port => {
    seed('ZCC'); vi.stubEnv('ZCC_ACP_DYNAMIC_TOOL_PORT', port);
    expect(read).toThrow('must be a positive integer');
  });
  it.each(['HOST', 'TOKEN', 'THREAD_ID', 'TOOLS'])('rejects missing %s', key => {
    seed('ZCC'); vi.stubEnv(key === 'TOOLS' ? 'ZCC_ACP_DYNAMIC_TOOLS' : `ZCC_ACP_DYNAMIC_TOOL_${key}`, undefined);
    expect(read).toThrow('Missing ACP dynamic tool');
  });
  it.each(['{invalid', '[{"name":1}]'])('rejects malformed tool declarations', value => {
    seed('ZCC'); vi.stubEnv('ZCC_ACP_DYNAMIC_TOOLS', value); expect(read).toThrow();
  });
});

it.each([[undefined, undefined], ['bad', undefined], ['0', undefined], ['250', 250]] as const)('validates optional progress interval %s', (value, expected) => {
  seed('ZCC'); vi.stubEnv('ZCC_ACP_DYNAMIC_TOOL_PROGRESS_INTERVAL_MS', value);
  expect(readShared().progressIntervalMs).toBe(expected);
});
