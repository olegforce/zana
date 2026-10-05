import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCommandRuntime, dispatchHostCommand } from './command-dispatch.js';

const roots: string[] = [];
function root() { const dir = mkdtempSync(join(tmpdir(), 'host-fs-budget-')); roots.push(dir); return dir; }
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const runtime = () => createCommandRuntime({ verifyProviders: async () => ({ providers: [] }) });

describe('bounded asynchronous host filesystem commands', () => {
  it('contains unavailable plugin workers and cancels provisioning idempotently', async () => {
    const host = runtime();
    const identity = { pluginId: 'fixture', generation: 'fixture', workerId: 'fixture' };
    await expect(dispatchHostCommand(host, { type: 'plugin.host.call', ...identity, artifact: { digest: 'a'.repeat(64), byteLength: 1 }, callId: 'call', method: 'ping', input: null, timeoutMs: 100 })).rejects.toMatchObject({ code: 'unsupported' });
    await expect(dispatchHostCommand(host, { type: 'plugin.host.cancel', ...identity, callId: 'call' })).rejects.toMatchObject({ code: 'unsupported' });
    await expect(dispatchHostCommand(host, { type: 'plugin.host.dispose', ...identity })).rejects.toMatchObject({ code: 'unsupported' });
    const controller = new AbortController(); host.provisionSignals.set('environment', controller);
    await dispatchHostCommand(host, { type: 'environment.provision.cancel', environmentId: 'environment' });
    expect(controller.signal.aborted).toBe(true);
    await expect(dispatchHostCommand(host, { type: 'environment.provision.cancel', environmentId: 'missing' })).resolves.toMatchObject({ cancelled: true });
    await expect(dispatchHostCommand(host, { type: 'provider.agent_descriptors', profile: 'invalid' as never })).resolves.toEqual({ status: 'failure' });
  });

  it('confines recursive listings, skips invalid links and metadata, and terminates cycles and deep trees', async () => {
    const dir = root(), outside = root();
    writeFileSync(join(dir, 'index.json'), '{}'); writeFileSync(join(dir, 'ok.txt'), 'ok');
    symlinkSync(outside, join(dir, 'escape')); symlinkSync(join(dir, 'missing'), join(dir, 'broken'));
    symlinkSync(dir, join(dir, 'cycle'));
    let deep = dir;
    for (let i = 0; i < 34; i++) { deep = join(deep, 'deep'); mkdirSync(deep); }
    writeFileSync(join(deep, 'too-deep.txt'), 'hidden');
    const result = await dispatchHostCommand(runtime(), { type: 'host.list_files', roots: [dir, join(dir, 'missing'), join(dir, 'ok.txt')] }) as { files: Array<{ relPath: string }> };
    expect(result.files.some(file => file.relPath === 'ok.txt')).toBe(true);
    expect(result.files.some(file => /escape|broken|cycle|index.json|too-deep/.test(file.relPath))).toBe(false);
    expect(result.files.length).toBeLessThan(40);
  });

  it('caps recursive and shallow listings without loading every file into the result', async () => {
    const dir = root();
    for (let i = 0; i < 2005; i++) writeFileSync(join(dir, `file-${i}.txt`), '');
    const recursive = await dispatchHostCommand(runtime(), { type: 'host.list_files', roots: [dir] }) as { files: unknown[] };
    const shallow = await dispatchHostCommand(runtime(), { type: 'host.list_dir', root: dir, relPath: '.' }) as { entries: unknown[] };
    expect(recursive.files).toHaveLength(500); expect(shallow.entries).toHaveLength(2000);
  });

  it('classifies shallow links and rejects unavailable roots and non-directories', async () => {
    const dir = root(); mkdirSync(join(dir, 'folder')); mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'file'), 'text');
    symlinkSync(join(dir, 'folder'), join(dir, 'dir-link')); symlinkSync(join(dir, 'file'), join(dir, 'file-link'));
    symlinkSync(join(dir, 'missing'), join(dir, 'broken'));
    const result = await dispatchHostCommand(runtime(), { type: 'host.list_dir', root: dir, relPath: '' }) as { entries: Array<{ name: string; kind: string }> };
    expect(result.entries.map(entry => [entry.name, entry.kind])).toEqual([['dir-link', 'dir'], ['folder', 'dir'], ['file', 'file'], ['file-link', 'file']]);
    for (const [base, relPath] of [[join(dir, 'missing'), ''], [join(dir, 'file'), '.'], [dir, 'file']]) {
      await expect(dispatchHostCommand(runtime(), { type: 'host.list_dir', root: base, relPath })).rejects.toMatchObject({ code: 'path_not_found' });
    }
  });

  it('handles unreadable directories without aborting a listing', async () => {
    const dir = root(), locked = join(dir, 'locked'); mkdirSync(locked); chmodSync(locked, 0);
    try {
      await expect(dispatchHostCommand(runtime(), { type: 'host.list_dir', root: dir, relPath: 'locked' })).resolves.toEqual({ entries: [] });
      await expect(dispatchHostCommand(runtime(), { type: 'host.list_files', roots: [dir] })).resolves.toMatchObject({ files: [{ relPath: 'locked' }] });
    } finally { chmodSync(locked, 0o755); }
  });

  it('rejects oversized text and images, preserves empty files, and rejects directories', async () => {
    const dir = root();
    writeFileSync(join(dir, 'huge.txt'), Buffer.alloc(1_000_001));
    writeFileSync(join(dir, 'huge.png'), Buffer.alloc(10 * 1024 * 1024 + 1));
    writeFileSync(join(dir, 'empty.txt'), '');
    for (const relPath of ['huge.txt', 'huge.png']) {
      await expect(dispatchHostCommand(runtime(), { type: 'host.read_file', root: dir, relPath })).rejects.toMatchObject({ code: 'too_large' });
    }
    await expect(dispatchHostCommand(runtime(), { type: 'host.read_file', root: dir, relPath: 'empty.txt' })).resolves.toEqual({ content: '', encoding: 'utf8' });
    mkdirSync(join(dir, 'folder'));
    await expect(dispatchHostCommand(runtime(), { type: 'host.read_file', root: dir, relPath: 'folder' })).rejects.toMatchObject({ code: 'path_not_found' });
  });

  it('authorizes model discovery cwd only after canonical directory validation', async () => {
    const dir = root(); writeFileSync(join(dir, 'file'), '');
    const listModels = vi.fn(async () => ({ models: [] }));
    const host = createCommandRuntime({ verifyProviders: async () => ({ providers: [] }), listModels });
    for (const cwd of [join(dir, 'missing'), join(dir, 'file')]) {
      await expect(dispatchHostCommand(host, { type: 'provider.list_models', providerId: 'codex', cwd })).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(listModels).not.toHaveBeenCalled();
    await dispatchHostCommand(host, { type: 'provider.list_models', providerId: 'codex', cwd: dir });
    expect(listModels).toHaveBeenCalledWith({ providerId: 'codex', bridgeLaunch: undefined, cwd: expect.any(String) });
  });
});
