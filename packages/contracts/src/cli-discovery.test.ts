import { expect, it } from 'vitest';
import { CliDiscoveryCommandSchema, CliDiscoveryRequestSchema, CliDiscoveryResultSchema } from './cli-discovery.js';
import { HostRpcCommandSchema, parseHostRpcResult } from './host-rpc.js';
import { ServerRuntimeInboundSchema, SERVER_RUNTIME_PROTOCOL_VERSION } from './runtime.js';

const request = { projectId: 'p', query: 'roles', profile: 'opencode', nativeAgentDiscoveryEnabled: true };
it('validates the closed private request and host RPC surface', () => {
  expect(CliDiscoveryRequestSchema.safeParse(request).success).toBe(true);
  expect(ServerRuntimeInboundSchema.safeParse({ type: 'request', protocolVersion: SERVER_RUNTIME_PROTOCOL_VERSION,
    id: 'd2a56c9f-5c46-4b58-88bc-91d8c88e8c8f', deadlineAt: new Date().toISOString(), operation: 'cli-discovery', request }).success).toBe(true);
  const { projectId, ...params } = request;
  const command = { ...params, type: 'provider.cli_discovery', root: '/root', cwd: '/root/src' };
  expect(HostRpcCommandSchema.parse(command)).toEqual(command);
  for (const patch of [{ root: undefined }, { cwd: '/root\0evil' }, { env: {} }, { profile: 'unknown' }, { query: 'exec' }]) {
    expect(CliDiscoveryCommandSchema.safeParse({ ...command, ...patch }).success).toBe(false);
  }
  for (const patch of [{ hostId: '' }, { environmentId: '../bad' }, { projectId: '' }, { token: 'secret' }]) {
    expect(CliDiscoveryRequestSchema.safeParse({ ...request, ...patch }).success).toBe(false);
  }
});
it('bounds result metadata and rejects secrets, control paths and unknown queries', () => {
  expect(parseHostRpcResult('provider.cli_discovery', { query: 'models' })).toEqual({ query: 'models' });
  const role = { id: 'r', label: 'Role', scope: ['local'] };
  for (const value of [{ query: 'exec' }, { query: 'models', models: ['a\0b'] }, { query: 'models', models: Array(10001).fill('m') },
    { query: 'roles', roles: Array(2001).fill(role) }, { query: 'roles', roles: [{ ...role, token: 'secret' }] },
    { query: 'version', version: 'v'.repeat(201) }]) {
    expect(CliDiscoveryResultSchema.safeParse(value).success).toBe(false);
  }
});
