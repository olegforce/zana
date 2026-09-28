import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { asControlResult, cliAgentPresentationStatus, sessionToCliAgent, createCliAgentOpsViaControl, PRODUCT_SERVER_CREDENTIAL_ENV } from './cli-agent-ops.js';

describe('cli-agent-ops helpers', () => {
  it('passes through a control-plane result', () => {
    expect(asControlResult({ ok: true, value: { id: 's1' } })).toEqual({ ok: true, value: { id: 's1' } });
    expect(asControlResult({ ok: false, code: 'NOT_FOUND', message: 'gone' })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('projects a terminal session into the CLI Agent record', () => {
    expect(sessionToCliAgent({
      id: 's1',
      projectId: 'p1',
      profile: 'claude',
      title: 'hello',
      pid: 9
    }, 'idle')).toEqual({
      id: 's1',
      projectId: 'p1',
      profile: 'claude',
      title: 'hello',
      status: 'idle',
      pid: 9
    });
  });

  it('prefers an exited terminal over a dropped agent-status row', () => {
    expect(cliAgentPresentationStatus({ status: 'exited' }, 'unknown')).toBe('exited');
    expect(cliAgentPresentationStatus({ status: 'running' }, 'idle')).toBe('idle');
    expect(cliAgentPresentationStatus({ status: 'running' }, undefined)).toBe('running');
  });
});


it('skips desktop invalidation for a standalone server', async () => {
  vi.stubEnv(PRODUCT_SERVER_CREDENTIAL_ENV, '');
  try { await expect(createCliAgentOpsViaControl('/not-used').invalidateModelCatalog!('codex')).resolves.toBeUndefined(); }
  finally { vi.unstubAllEnvs(); }
});

it.each([true, false])('awaits desktop model invalidation and reports failure (ok=%s)', async (ok) => {
  const dir = mkdtempSync(join(tmpdir(), 'zcc-mc-'));
  const socketPath = join(dir, 's');
  const calls: unknown[] = [];
  const server = createServer(socket => {
    socket.once('data', data => {
      calls.push(JSON.parse(data.toString()));
      socket.end(JSON.stringify(ok ? { ok: true, value: null } : { ok: false, code: 'UNAVAILABLE', message: 'cache unavailable' }) + '\n');
    });
  });
  vi.stubEnv(PRODUCT_SERVER_CREDENTIAL_ENV, 'fixture-secret');
  try {
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    writeFileSync(join(dir, 'control.token'), JSON.stringify({ token: 'fixture', nonce: 'nonce', socket: socketPath }));
    const request = createCliAgentOpsViaControl(dir).invalidateModelCatalog!('acp-opencode');
    if (ok) await expect(request).resolves.toBeUndefined();
    else await expect(request).rejects.toThrow('Desktop model cache could not be refreshed: cache unavailable');
    expect(calls).toEqual([{ token: 'fixture', nonce: 'nonce', callerCredential: 'fixture-secret',
      op: 'harness.models.invalidate', args: { providerId: 'acp-opencode' } }]);
  } finally {
    vi.unstubAllEnvs();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
