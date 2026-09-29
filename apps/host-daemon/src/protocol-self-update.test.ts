import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create } from 'tar';
import { HOST_RPC_PROTOCOL_VERSION as protocol } from '@zana-ai/zcc-contracts/host-rpc';
import { SELF_UPDATE_MAX_BYTES, handleProtocolMismatch, confirmHostUpdate, rollbackHostUpdate, validateHostBundle } from './protocol-self-update.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'zcc-update-')); roots.push(root);
  const dataDir = join(root, 'data'), source = join(root, 'source');
  await mkdir(source); await mkdir(join(dataDir, 'runtime'), { recursive: true });
  await writeFile(join(dataDir, 'runtime/join.mjs'), '// old executable');
  await writeFile(join(source, 'package.json'), '{"type":"module"}');
  await writeFile(join(source, 'join.mjs'), `import './bb-provider-bridge-worker.mjs'; process.exit(Number(process.argv[3]) === ${protocol + 1} ? 0 : 1);`);
  await writeFile(join(source, 'bb-provider-bridge-worker.mjs'), 'export const worker = true;');
  await writeFile(join(source, 'bb-pi-bridge.mjs'), 'export const pi = true;');
  await writeFile(join(source, 'zcc-plugin-host-worker.mjs'), 'export const worker = true;');
  const pack = async (extra: string[] = []) => {
    const file = join(root, 'update.tgz');
    await create({ file, cwd: source, gzip: true, portable: true }, ['package.json', 'join.mjs', 'bb-provider-bridge-worker.mjs', 'bb-pi-bridge.mjs', 'zcc-plugin-host-worker.mjs', ...extra]);
    return readFile(file);
  };
  const archive = await pack();
  const fetchFn = vi.fn<typeof fetch>(async input => new Response(String(input).endsWith('/version')
    ? JSON.stringify({ protocolVersion: protocol + 1 }) : archive));
  return { root, source, dataDir, pack, fetchFn, options: { dataDir, serverUrl: 'http://127.0.0.1:8780/', enabled: true, now: 10_000, fetchFn } };
}
describe('protocol self-update', () => {
  it('promotes a complete validated generation and confirms after handshake', async () => {
    const f = await fixture();
    expect(await handleProtocolMismatch(f.options)).toBe('updated');
    await validateHostBundle(join(f.dataDir, 'runtime/join.mjs'), protocol + 1);
    expect(await readdir(join(f.dataDir, 'runtime'))).toContain('update-pending.json');
    await confirmHostUpdate(f.dataDir);
    expect((await readdir(join(f.dataDir, 'runtime'))).sort()).toEqual(['join.mjs', expect.stringMatching(/^release-/)]);
    expect(await rollbackHostUpdate(f.dataDir)).toBe(false);
  });
  it('rolls back a failed startup, including a previous symlink generation', async () => {
    const f = await fixture();
    expect(await handleProtocolMismatch(f.options)).toBe('updated');
    expect(await rollbackHostUpdate(f.dataDir)).toBe(true);
    expect(await readFile(join(f.dataDir, 'runtime/join.mjs'), 'utf8')).toBe('// old executable');
    expect(await handleProtocolMismatch({ ...f.options, now: 20_000 })).toBe('updated');
    await confirmHostUpdate(f.dataDir);
    const before = await readFile(join(f.dataDir, 'runtime/join.mjs'), 'utf8');
    expect(await handleProtocolMismatch({ ...f.options, now: 40_000 })).toBe('updated');
    expect(await rollbackHostUpdate(f.dataDir)).toBe(true);
    expect(await readFile(join(f.dataDir, 'runtime/join.mjs'), 'utf8')).toBe(before);
    expect((await readdir(join(f.dataDir, 'runtime'))).filter(p => p.startsWith('release-'))).toHaveLength(1);
  });
  it('coalesces updates and backs off failed attempts even on forced retry', async () => {
    const f = await fixture(); f.fetchFn.mockRejectedValue(new Error('offline'));
    const first = handleProtocolMismatch(f.options);
    expect(handleProtocolMismatch(f.options)).toBe(first);
    expect(await first).toBe('failed');
    expect(await handleProtocolMismatch({ ...f.options, force: true, now: 14_999 })).toBe('backoff');
    expect(f.fetchFn).toHaveBeenCalledTimes(1);
    expect(await handleProtocolMismatch({ ...f.options, now: 15_000 })).toBe('failed');
    expect(await handleProtocolMismatch({ ...f.options, now: 24_999 })).toBe('backoff');
  });
  it('skips disabled and non-newer protocols', async () => {
    const f = await fixture();
    expect(await handleProtocolMismatch({ ...f.options, enabled: false })).toBe('skipped');
    expect(f.fetchFn).not.toHaveBeenCalled();
    f.fetchFn.mockResolvedValue(new Response(JSON.stringify({ protocolVersion: protocol })));
    expect(await handleProtocolMismatch(f.options)).toBe('skipped');
  });
  it.each(['invalid-gzip', 'oversize-header', 'oversize-stream', 'extra-file', 'symlink', 'wrong-protocol', 'http-error'])('rejects %s without replacing the executable or leaving staging files', async mode => {
    const f = await fixture(); let response: Response;
    if (mode === 'extra-file' || mode === 'symlink') {
      if (mode === 'extra-file') await writeFile(join(f.source, 'unexpected'), 'bad');
      else await symlink('/tmp', join(f.source, 'unexpected'));
      response = new Response(await f.pack(['unexpected']));
    } else if (mode === 'wrong-protocol') {
      await writeFile(join(f.source, 'join.mjs'), 'process.exit(1)'); response = new Response(await f.pack());
    } else if (mode === 'oversize-header') response = new Response('x', { headers: { 'content-length': String(SELF_UPDATE_MAX_BYTES + 1) } });
    else if (mode === 'oversize-stream') response = new Response(Buffer.alloc(SELF_UPDATE_MAX_BYTES + 1));
    else response = new Response('not a tarball', { status: mode === 'http-error' ? 500 : 200 });
    f.fetchFn.mockImplementation(async input => String(input).endsWith('/version') ? new Response(JSON.stringify({ protocolVersion: protocol + 1 })) : response);
    expect(await handleProtocolMismatch(f.options)).toBe('failed');
    expect(await readFile(join(f.dataDir, 'runtime/join.mjs'), 'utf8')).toBe('// old executable');
    expect(await readdir(join(f.dataDir, 'runtime'))).toEqual(['join.mjs']);
  });
  it('rejects paths in a corrupted pending marker', async () => {
    const f = await fixture();
    await writeFile(join(f.dataDir, 'runtime/update-pending.json'), JSON.stringify({ entry: '../victim', backup: '../victim', generation: '..' }));
    expect(await rollbackHostUpdate(f.dataDir)).toBe(false); await confirmHostUpdate(f.dataDir);
  });
});
