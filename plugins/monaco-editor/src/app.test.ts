/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React, { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectTestPluginApp } from '@zana-ai/zcc-plugin-sdk/testing/app';
import app from '../app.js';

afterEach(() => {
  cleanup();
  delete (globalThis as { __ZCC_HOST_REACT__?: typeof React }).__ZCC_HOST_REACT__;
  delete (globalThis as { __ZCC_PLUGIN_RUNTIME__?: unknown }).__ZCC_PLUGIN_RUNTIME__;
  delete (globalThis as { __ZCC_MONACO__?: unknown }).__ZCC_MONACO__;
});

describe('monaco-editor file opener', () => {
  beforeEach(() => {
    (globalThis as { __ZCC_HOST_REACT__?: typeof React }).__ZCC_HOST_REACT__ = React;
  });

  function opener() {
    const registered = collectTestPluginApp(app, 'monaco-editor').fileOpeners[0];
    if (!registered) throw new Error('missing code opener');
    return registered;
  }

  function Original() {
    return createElement('div', { 'data-testid': 'original' }, 'host preview');
  }

  const source = {
    kind: 'workspace',
    threadId: 'thr_1',
    environmentId: null,
    projectId: 'p1'
  };

  function editorHarness(write: (input: any) => unknown) {
    let value = 'original'; let changed = () => {}; let command = () => {}; let reads = 0;
    const rpc = { async call(method: string, input: any) { if (method === 'read') { reads++; return { kind: 'text', content: 'original', sha256: `read-${reads}` }; } return write(input); } };
    Object.assign(globalThis, { __ZCC_PLUGIN_RUNTIME__: { useRpc: () => rpc }, __ZCC_MONACO__: {
      KeyMod: { CtrlCmd: 1 }, KeyCode: { KeyS: 2 }, editor: { create() { return {
        getValue: () => value, onDidChangeModelContent(fn: () => void) { changed = fn; return { dispose() {} }; },
        addCommand(_id: number, fn: () => void) { command = fn; }, dispose() {}
      }; } }
    } });
    return { edit(next: string) { act(() => { value = next; changed(); }); }, save() { act(() => command()); }, reads: () => reads };
  }

  it('retries a conflict against the returned revision and never bypasses it', async () => {
    const revisions: unknown[] = [];
    const editor = editorHarness(input => { revisions.push(input.expectedSha256); return revisions.length < 3 ? { outcome: 'conflict', currentSha256: `conflict-${revisions.length}` } : { outcome: 'written', sha256: 'saved' }; });
    const slot = render(createElement(opener().component, { path: 'a.ts', source, experimental_Original: Original }));
    await slot.findByRole('button', { name: 'Saved' }); editor.edit('changed');
    fireEvent.click(slot.getByRole('button', { name: 'Save' }));
    fireEvent.click(await slot.findByRole('button', { name: 'Disk changed — save anyway' }));
    await waitFor(() => expect(revisions).toHaveLength(2));
    fireEvent.click(await slot.findByRole('button', { name: 'Disk changed — save anyway' }));
    await slot.findByRole('button', { name: 'Saved' });
    expect(revisions).toEqual(['read-1', 'conflict-1', 'conflict-2']);
  });

  it('preserves in-flight edits, blocks duplicate saves and keeps equivalent source updates stable', async () => {
    let settle: ((value: unknown) => void) | undefined; let writes = 0;
    const editor = editorHarness(() => { writes++; return new Promise(resolve => { settle = resolve; }); });
    const props = { path: 'a.ts', source, experimental_Original: Original };
    const slot = render(createElement(opener().component, props));
    await slot.findByRole('button', { name: 'Saved' }); editor.edit('first'); editor.save();
    await slot.findByRole('button', { name: 'Saving…' }); editor.edit('second'); editor.save();
    slot.rerender(createElement(opener().component, { ...props, source: { ...source } }));
    expect(editor.reads()).toBe(1); expect(writes).toBe(1);
    await act(async () => settle?.({ outcome: 'written', sha256: 'first-revision' }));
    await slot.findByRole('button', { name: 'Save' });
    editor.save();
    await act(async () => settle?.({ outcome: 'unsupported', reason: 'machine unavailable' }));
    expect((await slot.findByRole('alert')).textContent).toContain('machine unavailable');
    await slot.findByRole('button', { name: 'Retry save' });
  });

  it('ignores a save response after switching files', async () => {
    let settle: ((value: unknown) => void) | undefined;
    const editor = editorHarness(() => new Promise(resolve => { settle = resolve; }));
    const props = { path: 'a.ts', source, experimental_Original: Original };
    const slot = render(createElement(opener().component, props));
    await slot.findByRole('button', { name: 'Saved' }); editor.edit('first'); editor.save();
    slot.rerender(createElement(opener().component, { ...props, path: 'b.ts' }));
    await waitFor(() => expect(editor.reads()).toBe(2));
    await slot.findByRole('button', { name: 'Saved' }); editor.edit('second');
    await act(async () => settle?.({ outcome: 'written', sha256: 'old-file-revision' }));
    await slot.findByRole('button', { name: 'Save' });
  });

  it('falls back when RPC is missing', () => {
    const slot = render(
      createElement(opener().component, {
        path: 'src/hello.ts',
        source,
        experimental_Original: Original
      })
    );
    expect(slot.getByTestId('original').textContent).toBe('host preview');
  });

  it('falls back when the file cannot be edited here', async () => {
    const rpcClient = {
      async call(method: string, input?: { content?: string }) {
        if (method === 'read') {
          return { kind: 'unsupported', reason: 'This project has no local path' };
        }
        return input;
      }
    };
    (globalThis as { __ZCC_PLUGIN_RUNTIME__?: unknown }).__ZCC_PLUGIN_RUNTIME__ = {
      useRpc: () => rpcClient
    };
    const slot = render(
      createElement(opener().component, {
        path: 'src/hello.ts',
        source,
        experimental_Original: Original
      })
    );
    await waitFor(() => expect(slot.getByTestId('original')).toBeTruthy());
  });

  it('creates a host Monaco editor and saves on demand', async () => {
    let content = 'export const n = 1;\n';
    const commands: Array<() => void> = [];
    const rpcClient = {
      async call(method: string, input: { content?: string }) {
        if (method === 'read') {
          return { kind: 'text', content, sha256: 'abc' };
        }
        content = input.content ?? content;
        return { outcome: 'written', sha256: 'def' };
      }
    };
    (globalThis as { __ZCC_PLUGIN_RUNTIME__?: unknown }).__ZCC_PLUGIN_RUNTIME__ = {
      useRpc: () => rpcClient
    };
    (globalThis as { __ZCC_MONACO__?: unknown }).__ZCC_MONACO__ = {
      KeyMod: { CtrlCmd: 2048 },
      KeyCode: { KeyS: 49 },
      editor: {
        create(_container: unknown, opts: { value: string }) {
          return {
            getValue: () => opts.value.replace('1', '2'),
            onDidChangeModelContent(listener: () => void) {
              setTimeout(listener, 0);
              return { dispose() {} };
            },
            addCommand(_id: number, fn: () => void) {
              commands.push(fn);
            },
            dispose() {}
          };
        }
      }
    };
    const slot = render(
      createElement(opener().component, {
        path: 'src/hello.ts',
        source,
        experimental_Original: Original
      })
    );
    const save = await slot.findByRole('button', { name: 'Save' });
    fireEvent.click(save);
    await waitFor(() => expect(slot.getByRole('button', { name: 'Saved' })).toBeTruthy());
    expect(content).toContain('n = 2');
    commands[0]?.();
  });

  it('shows editor load errors', async () => {
    const rpcClient = {
      async call() {
        throw new Error('read failed');
      }
    };
    (globalThis as { __ZCC_PLUGIN_RUNTIME__?: unknown }).__ZCC_PLUGIN_RUNTIME__ = {
      useRpc: () => rpcClient
    };
    const slot = render(
      createElement(opener().component, {
        path: 'src/hello.ts',
        source,
        experimental_Original: Original
      })
    );
    await slot.findByRole('alert');
    expect(slot.getByRole('alert').textContent).toContain('read failed');
  });
});
