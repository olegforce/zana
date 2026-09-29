import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { collectTestPluginApp } from '@zana-ai/zcc-plugin-sdk/testing/app';
import { createFakePluginHost } from '@zana-ai/zcc-plugin-sdk/testing';
import { derivePluginId } from '@zana-ai/zcc-domain';
import { CLAIMED_EXTENSIONS, languageForPath } from '../languages.js';
import { confineToRoot, isBinaryBuffer, parseFileSource } from '../file-rpc.js';
import app from '../app.js';
import plugin from '../server.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('monaco-editor plugin contract', () => {
  it('derives a stable id and claims code extensions, not markdown or pdf', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string };
    expect(derivePluginId(pkg.name)).toBe('monaco-editor');
    const set = collectTestPluginApp(app, 'monaco-editor');
    expect(set.fileOpeners[0]?.id).toBe('code');
    expect(set.fileOpeners[0]?.extensions).toEqual([...CLAIMED_EXTENSIONS]);
    expect(set.fileOpeners[0]?.title).toBe('File Editor');
    expect(CLAIMED_EXTENSIONS).toContain('ts');
    expect(CLAIMED_EXTENSIONS).not.toContain('md');
    expect(CLAIMED_EXTENSIONS).not.toContain('pdf');
    expect(languageForPath('src/App.tsx')).toBe('typescript');
    expect(languageForPath('Makefile')).toBe('plaintext');
    expect(languageForPath('notes.')).toBe('plaintext');
    expect(languageForPath('unknown.xyz')).toBe('plaintext');
  });

  it('confines writes to the project root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcc-monaco-root-'));
    tempDirs.push(dir);
    expect(confineToRoot(dir, 'src/hello.ts')).toBe(join(dir, 'src', 'hello.ts'));
    expect(() => confineToRoot(dir, '../etc/passwd')).toThrow(/not inside/);
  });

  it('rejects binary buffers and incomplete file sources', () => {
    expect(isBinaryBuffer(Buffer.from('hello'))).toBe(false);
    expect(isBinaryBuffer(Buffer.from([0, 1, 2]))).toBe(true);
    expect(() => parseFileSource({})).toThrow(/path is required/);
    expect(() =>
      parseFileSource({ path: 'a.ts', source: { kind: 'remote' } })
    ).toThrow(/unsupported file source/);
    const parsed = parseFileSource({
      path: 'src/a.ts',
      source: { kind: 'workspace', projectId: 'p1' },
      content: 'x'
    });
    expect(parsed.source.kind).toBe('workspace');
  });

  it('routes editing through the host SDK and preserves revision conflicts', async () => {
    const { zcc, harness } = createFakePluginHost({ pluginId: 'monaco-editor' });
    const source = { kind: 'workspace', projectId: 'p1', threadId: null, environmentId: null, hostId: 'machine-b' };
    harness.sdk.stub('files.readProject', () => ({ content: 'remote', contentEncoding: 'utf8', sizeBytes: 6, sha256: 'revision' }));
    harness.sdk.stub('files.writeProject', () => ({ outcome: 'written', sha256: 'next' }));
    await plugin(zcc);
    expect(await harness.callRpc('read', { path: 'src/a.ts', source })).toEqual({ kind: 'text', content: 'remote', sha256: 'revision' });
    expect(harness.sdk.callsTo('files.readProject')).toEqual([[{ path: 'src/a.ts', source }]]);
    expect(await harness.callRpc('write', { path: 'src/a.ts', source, content: 'changed', expectedSha256: 'revision' })).toEqual({ outcome: 'written', sha256: 'next' });
    expect(harness.sdk.callsTo('files.writeProject')).toEqual([[{ path: 'src/a.ts', source, content: 'changed', expectedSha256: 'revision' }]]);
    harness.sdk.stub('files.writeProject', () => ({ outcome: 'conflict', currentSha256: 'newer' }));
    expect(await harness.callRpc('write', { path: 'src/a.ts', source, content: 'changed', expectedSha256: 'revision' })).toEqual({ outcome: 'conflict', currentSha256: 'newer' });
    await expect(harness.callRpc('write', { path: 'src/a.ts', source })).rejects.toThrow('content');
  });

  it('delegates unsupported formats but surfaces host and confinement failures', async () => {
    const { zcc, harness } = createFakePluginHost({ pluginId: 'monaco-editor' });
    const file = { path: 'a.ts', source: { kind: 'workspace', projectId: 'p', threadId: null, environmentId: null } };
    await plugin(zcc);
    for (const result of [{ contentEncoding: 'base64', sizeBytes: 1 }, { contentEncoding: 'utf8', sizeBytes: 9 * 1024 * 1024 }]) {
      harness.sdk.stub('files.readProject', () => result);
      expect(await harness.callRpc('read', file)).toMatchObject({ kind: 'unsupported' });
    }
    const unsupported = () => { throw Object.assign(new Error('No project'), { code: 'unsupported' }); };
    harness.sdk.stub('files.readProject', unsupported); harness.sdk.stub('files.writeProject', unsupported);
    expect(await harness.callRpc('read', file)).toMatchObject({ kind: 'unsupported' });
    expect(await harness.callRpc('write', { ...file, content: 'x' })).toMatchObject({ outcome: 'unsupported' });
    const offline = () => { throw new Error('host offline'); };
    harness.sdk.stub('files.readProject', offline); harness.sdk.stub('files.writeProject', offline);
    await expect(harness.callRpc('read', file)).rejects.toThrow('host offline');
    await expect(harness.callRpc('write', { ...file, content: 'x' })).rejects.toThrow('host offline');
  });
});
