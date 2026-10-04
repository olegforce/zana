/**
 * Control-client tests. Spins up a real Unix-domain socket server that echoes
 * the parsed request, so we can assert: the socket-absent path returns a clean
 * APP_NOT_RUNNING (never throws), the token/nonce/callerSessionId are forwarded
 * faithfully, and a malformed response degrades gracefully.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { connect, createServer, type Server } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { callControlPlane, readControlToken, isAppRunning } from '../lib/control-client.js';
import * as deck from '../../../streamdeck/src/lib/control-client.js';

vi.mock('node:net', async (original) => {
  const actual = await original<typeof import('node:net')>();
  return { ...actual, connect: vi.fn(actual.connect) };
});
vi.mock('node:os', async (original) => {
  const actual = await original<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

let server: Server | null = null;
const dirs: string[] = [];

afterEach(async () => {
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.mocked(connect).mockReset();
  vi.mocked(connect).mockImplementation((await vi.importActual<typeof import('node:net')>('node:net')).connect);
  vi.mocked(homedir).mockReset();
  vi.mocked(homedir).mockImplementation((await vi.importActual<typeof import('node:os')>('node:os')).homedir);
});

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'zcc-cli-ctl-'));
  dirs.push(d);
  return d;
}

/** Start an echo control server that captures the last request it received. */
async function startEcho(dataDir: string, response?: string | null): Promise<{ socketPath: string; last: () => any }> {
  const socketPath = join(dataDir, 'control.sock');
  writeFileSync(
    join(dataDir, 'control.token'),
    JSON.stringify({ token: 'tk', nonce: 'nc', socket: socketPath })
  );
  let lastReq: any = null;
  server = createServer((socket) => {
    let buf = '';
    socket.on('data', (c) => {
      buf += c.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      lastReq = JSON.parse(buf.slice(0, nl));
      if (response === null) return;
      socket.end(response ?? JSON.stringify({ ok: true, value: { echoed: lastReq.op } }) + '\n');
    });
  });
  await new Promise<void>((resolve) => server!.listen(socketPath, () => resolve()));
  return { socketPath, last: () => lastReq };
}

describe('readControlToken / isAppRunning', () => {
  it('returns null + not-running when the token file is absent', () => {
    const d = freshDir();
    expect(readControlToken(d)).toBeNull();
    expect(isAppRunning(d)).toBe(false);
  });
});

describe('callControlPlane', () => {
  it('returns APP_NOT_RUNNING (never throws) when there is no socket', async () => {
    const d = freshDir();
    const r = await callControlPlane({ dataDir: d, op: 'status' });
    expect(r).toMatchObject({ ok: false, code: 'APP_NOT_RUNNING' });
  });

  it('forwards token, nonce, op, args and the caller-session marker', async () => {
    const d = freshDir();
    const echo = await startEcho(d);
    const r = await callControlPlane({
      dataDir: d,
      op: 'agent.send',
      args: { to: 'reviewer', message: 'hi' },
      callerSessionId: 'sess-xyz',
      callerCredential: 'bound-token'
    });
    expect(r).toMatchObject({ ok: true, value: { echoed: 'agent.send' } });
    expect(echo.last()).toMatchObject({
      token: 'tk',
      nonce: 'nc',
      op: 'agent.send',
      args: { to: 'reviewer', message: 'hi' },
      callerSessionId: 'sess-xyz',
      callerCredential: 'bound-token'
    });
  });

  it('defaults the caller-session marker from ZCC_SESSION_ID when set', async () => {
    const d = freshDir();
    const echo = await startEcho(d);
    const prev = process.env.ZCC_SESSION_ID;
    process.env.ZCC_SESSION_ID = 'env-session';
    const prevToken = process.env.ZCC_SESSION_TOKEN;
    process.env.ZCC_SESSION_TOKEN = 'env-token';
    try {
      await callControlPlane({ dataDir: d, op: 'status' });
    } finally {
      if (prev === undefined) delete process.env.ZCC_SESSION_ID;
      else process.env.ZCC_SESSION_ID = prev;
      if (prevToken === undefined) delete process.env.ZCC_SESSION_TOKEN;
      else process.env.ZCC_SESSION_TOKEN = prevToken;
    }
    expect(echo.last().callerSessionId).toBe('env-session');
    expect(echo.last().callerCredential).toBe('env-token');
  });
});

describe.each([
  ['CLI', { callControlPlane, readControlToken, isAppRunning }],
  ['Stream Deck', deck]
] as const)('%s endpoint and failure handling', (_name, client) => {
  it('rejects absent, malformed, incomplete and stale filesystem tokens', async () => {
    const d = freshDir();
    expect(await client.callControlPlane({ dataDir: d, op: 'status' })).toMatchObject({ ok: false, code: 'APP_NOT_RUNNING' });
    for (const contents of ['invalid', '{}', JSON.stringify({ token: 'tk', nonce: 'nc', socket: join(d, 'absent.sock') })]) {
      writeFileSync(join(d, 'control.token'), contents);
      expect(client.isAppRunning(d)).toBe(false);
      expect(await client.callControlPlane({ dataDir: d, op: 'status' })).toMatchObject({ ok: false, code: 'APP_NOT_RUNNING' });
    }
  });

  it('connects to a named pipe without a filesystem existence check and forwards credentials', async () => {
    const d = freshDir();
    const echo = await startEcho(d);
    const pipe = '\\\\.\\pipe\\zcc-control-unit-test';
    writeFileSync(join(d, 'control.token'), JSON.stringify({ token: 'tk', nonce: 'nc', socket: pipe }));
    const actual = await vi.importActual<typeof import('node:net')>('node:net');
    vi.mocked(connect).mockImplementation(((path: string) => {
      expect(path).toBe(pipe);
      return actual.connect(echo.socketPath);
    }) as typeof connect);
    expect(client.isAppRunning(d)).toBe(true);
    expect(await client.callControlPlane({ dataDir: d, op: 'status', callerSessionId: 'session', callerCredential: 'credential' })).toMatchObject({ ok: true });
    expect(echo.last()).toMatchObject({ token: 'tk', nonce: 'nc', callerSessionId: 'session', callerCredential: 'credential' });
  });

  it.each(['not-json\n', 'not-json'])('handles a malformed response %j', async (response) => {
    const d = freshDir(); await startEcho(d, response);
    expect(await client.callControlPlane({ dataDir: d, op: 'status' })).toMatchObject({ ok: false, code: 'BAD_RESPONSE' });
  });

  it('accepts a complete response without a newline', async () => {
    const d = freshDir(); await startEcho(d, JSON.stringify({ ok: true, value: 'end-framed' }));
    expect(await client.callControlPlane({ dataDir: d, op: 'status' })).toEqual({ ok: true, value: 'end-framed' });
  });

  it('times out and destroys an unresponsive connection', async () => {
    const d = freshDir(); await startEcho(d, null);
    expect(await client.callControlPlane({ dataDir: d, op: 'status', timeoutMs: 25 })).toMatchObject({ ok: false, code: 'TIMEOUT' });
  });

  it('returns a socket error for a stale named-pipe token', async () => {
    const d = freshDir();
    writeFileSync(join(d, 'control.token'), JSON.stringify({ token: 'tk', nonce: 'nc', socket: '\\\\.\\pipe\\zcc-stale' }));
    const actual = await vi.importActual<typeof import('node:net')>('node:net');
    vi.mocked(connect).mockImplementation((() => actual.connect(join(d, 'missing.sock'))) as typeof connect);
    expect(await client.callControlPlane({ dataDir: d, op: 'status' })).toMatchObject({ ok: false, code: 'SOCKET_ERR' });
  });
});

it('resolves Stream Deck defaults from an isolated home, preferring current over legacy data', async () => {
  const home = freshDir();
  vi.mocked(homedir).mockReturnValue(home);
  const next = join(home, '.zcc');
  const legacy = join(home, '.cc-center');
  expect(deck.resolveDataDir()).toBe(next);
  expect(await deck.callControlPlane({ op: 'status' })).toMatchObject({ ok: false, code: 'APP_NOT_RUNNING' });
  mkdirSync(legacy);
  expect(deck.resolveDataDir()).toBe(legacy);
  mkdirSync(next);
  expect(deck.resolveDataDir()).toBe(next);
  await startEcho(next);
  expect(await deck.callControlPlane({ op: 'status' })).toMatchObject({ ok: true });
});
