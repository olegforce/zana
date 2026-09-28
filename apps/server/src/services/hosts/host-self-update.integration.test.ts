import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { HOST_RPC_PROTOCOL_VERSION as protocol } from '@zana-ai/zcc-contracts/host-rpc';
import { resolveHostArtifact } from './host-artifact.js';

async function until<T>(read: () => T | Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 150; i++) {
    try { const value = await read(); if (predicate(value)) return value; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Host replacement did not become ready');
}
describe('real bundled host replacement', () => {
  it.each([false, true])('restarts the new protocol and completes its handshake, service-managed=%s', async managed => {
    const root = mkdtempSync(join(tmpdir(), 'zcc-real-update-'));
    const dataDir = join(root, 'machine'), runtime = join(dataDir, 'runtime');
    mkdirSync(runtime, { recursive: true });
    const artifact = resolveHostArtifact({ ...process.env, ZCC_HOST_ARTIFACT: '' });
    execFileSync('tar', ['-xzf', artifact.tarballPath, '-C', runtime]);
    const entry = join(runtime, 'join.mjs');
    const source = readFileSync(entry, 'utf8');
    const current = `var HOST_RPC_PROTOCOL_VERSION = ${protocol};`;
    expect(source.split(current)).toHaveLength(2);
    writeFileSync(entry, source.replace(current, `var HOST_RPC_PROTOCOL_VERSION = ${protocol - 1};`));
    const hostId = '11111111-1111-4111-8111-111111111111';
    const seen: number[] = [];
    const server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/install/version') return response.end(JSON.stringify({ protocolVersion: protocol }));
      if (request.url === '/install/zcc-host.tgz') return response.end(readFileSync(artifact.tarballPath));
      if (request.url === '/internal/hosts/enroll') {
        let body = ''; for await (const chunk of request) body += chunk;
        const version = JSON.parse(body).protocolVersion; seen.push(version);
        response.statusCode = version === protocol ? 201 : 409;
        return response.end(JSON.stringify({ protocolVersion: protocol, hostId, hostKey: 'k'.repeat(40) }));
      }
      response.statusCode = 404; response.end('{}');
    });
    const sockets = new WebSocketServer({ server });
    sockets.on('connection', socket => socket.on('message', bytes => {
      const message = JSON.parse(String(bytes));
      if (message.type === 'host.hello') socket.send(JSON.stringify({ type: 'host.hello-ok', protocolVersion: protocol, hostId }));
    }));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const serverUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const portPicker = createServer(); await new Promise<void>(resolve => portPicker.listen(0, '127.0.0.1', resolve));
    const port = (portPicker.address() as { port: number }).port;
    await new Promise<void>(resolve => portPicker.close(() => resolve()));
    const children: ChildProcess[] = [];
    let replacementPid: number | undefined;
    const launch = () => {
      const child = spawn(process.execPath, [entry, 'join', '--join-code', 'test', '--server-url', serverUrl, '--host-daemon-port', String(port), '--auto-update'], {
        cwd: root, stdio: 'ignore', env: { ...process.env, HOME: root, ZCC_DATA_DIR: dataDir, ZCC_HOST_SERVICE_MANAGED: managed ? '1' : '0' }
      }); children.push(child); return child;
    };
    try {
      const first = launch();
      await until(() => first.exitCode, code => code !== null);
      expect(first.exitCode).toBe(0);
      if (managed) launch(); // emulate the service manager restarting its stable ExecStart
      const state = await until(async () => (await fetch(`http://127.0.0.1:${port}/status`)).json(), value => value.connected === true);
      expect(state.protocolVersion).toBe(protocol);
      expect(seen).toEqual([protocol - 1, protocol]);
      expect(readFileSync(entry, 'utf8')).toContain(current);
      await until(() => { try { readFileSync(join(runtime, 'update-pending.json')); return false; } catch { return true; } }, done => done);
      if (!managed) {
        replacementPid = Number(readFileSync(join(dataDir, 'host-daemon.pid'), 'utf8'));
        expect(replacementPid).not.toBe(first.pid);
        expect(replacementPid).toBeGreaterThan(1);
      }
    } finally {
      // Read only this fixture's refreshed PID, even when an assertion failed.
      if (!managed && !replacementPid) { try { replacementPid = Number(readFileSync(join(dataDir, 'host-daemon.pid'), 'utf8')); } catch {} }
      for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
      if (replacementPid && replacementPid > 1) { try { process.kill(replacementPid, 'SIGTERM'); } catch {} }
      for (const socket of sockets.clients) socket.terminate();
      sockets.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      await new Promise(resolve => setTimeout(resolve, 200));
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
