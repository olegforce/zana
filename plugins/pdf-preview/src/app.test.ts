/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React, { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectTestPluginApp } from '@zana-ai/zcc-plugin-sdk/testing/app';
import app from '../app.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (globalThis as { __ZCC_HOST_REACT__?: typeof React }).__ZCC_HOST_REACT__;
});

describe('pdf-preview file opener', () => {
  beforeEach(() => {
    (globalThis as { __ZCC_HOST_REACT__?: typeof React }).__ZCC_HOST_REACT__ = React;
    (window as any).happyDOM.settings.disableIframePageLoading = true;
  });

  function opener() {
    const registered = collectTestPluginApp(app, 'pdf-preview').fileOpeners[0];
    if (!registered) throw new Error('missing pdf opener');
    return registered;
  }

  function Original() {
    return createElement('div', { 'data-testid': 'original' }, 'host preview');
  }

  it('falls back to the host preview without a thread id', () => {
    const slot = render(
      createElement(opener().component, {
        path: 'docs/spec.pdf',
        source: { kind: 'workspace', threadId: null, environmentId: null, projectId: 'p1' },
        experimental_Original: Original
      })
    );
    expect(slot.getByTestId('original').textContent).toBe('host preview');
  });

  it('shows loading while the PDF is requested', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => undefined))
    );
    const slot = render(
      createElement(opener().component, {
        path: 'docs/spec.pdf',
        source: { kind: 'workspace', threadId: 'thr_1', environmentId: null, projectId: 'p1' },
        experimental_Original: Original
      })
    );
    expect(slot.getByRole('status').textContent).toContain('Loading PDF');
  });

  it('shows a retryable error when the PDF request fails', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    const slot = render(
      createElement(opener().component, {
        path: 'docs/spec.pdf',
        source: { kind: 'host', threadId: 'thr_1', environmentId: 'env', projectId: 'p1' },
        experimental_Original: Original
      })
    );
    await slot.findByRole('alert');
    expect(slot.getByRole('alert').textContent).toContain('status 500');
    fireEvent.click(slot.getByRole('button', { name: 'Retry' }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the original bytes downloadable before the frame renders and releases them on close', async () => {
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:pdf-preview');
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const fetchMock = vi.fn(async (_target: string, _options: RequestInit) => ({ ok: true, json: async () => ({ content: btoa('%PDF-1.4\n'), encoding: 'base64' }) }));
    vi.stubGlobal('fetch', fetchMock);
    const slot = render(createElement(opener().component, {
      path: 'docs/spec.pdf',
      source: { kind: 'workspace', threadId: 'thr_1', environmentId: null, projectId: 'p1' },
      experimental_Original: Original
    }));
    const download = await slot.findByRole('link', { name: 'Download PDF' });
    expect(download.getAttribute('download')).toBe('spec.pdf');
    expect(download.getAttribute('href')).toBe('blob:pdf-preview');
    expect(createUrl.mock.calls[0][0]).toMatchObject({ type: 'application/pdf', size: 9 });
    expect(fetchMock.mock.calls[0][0]).toContain('projectId=p1');
    expect(slot.getByRole('status').textContent).toContain('Rendering PDF');
    fireEvent.load(slot.getByTitle('docs/spec.pdf'));
    expect(slot.queryByRole('status')).toBeNull();
    slot.unmount();
    expect(revokeUrl).toHaveBeenCalledWith('blob:pdf-preview');
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    createUrl.mockRestore();
    revokeUrl.mockRestore();
  });

  it('ignores a completed request after closing the preview', async () => {
    let finish!: (value: unknown) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { finish = resolve; })));
    const createUrl = vi.spyOn(URL, 'createObjectURL');
    const slot = render(createElement(opener().component, {
      path: 'a.pdf', source: { kind: 'host', threadId: 't' }, experimental_Original: Original
    }));
    slot.unmount();
    await act(async () => { finish({ ok: true, json: async () => ({ content: '%PDF-1.4\n' }) }); });
    expect(createUrl).not.toHaveBeenCalled();
    createUrl.mockRestore();
  });

  it('shows rejected fetch errors and malformed files', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce('Offline').mockResolvedValueOnce({ ok: true, json: async () => ({ content: 'not a PDF' }) });
    vi.stubGlobal('fetch', fetchMock);
    const slot = render(createElement(opener().component, {
      path: 'a.pdf', source: { kind: 'host', threadId: 't' }, experimental_Original: Original
    }));
    expect((await slot.findByRole('alert')).textContent).toContain('Offline');
    fireEvent.click(slot.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(slot.getByRole('alert').textContent).toContain('not a PDF'));
    expect(slot.queryByRole('link', { name: 'Download PDF' })).toBeNull();
  });
});
