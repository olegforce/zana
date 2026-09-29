// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { FsReadDataUrlResult, LibraryDoc } from '@zana-ai/zcc-domain/product';
const read = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/product-client.js', () => ({ product: { library: { readAsset: read } } }));
import { LibraryAssetPreview } from './LibraryAssetPreview.js';
const doc = { id: 'asset', scope: 'project', projectId: 'p', relPath: 'a.png', absPath: '/must/not/use/local/a.png', kind: 'image', title: 'Shared image' } as LibraryDoc;
afterEach(() => { cleanup(); read.mockReset(); });
it('uses scoped bytes for images and PDFs without exposing a desktop file URL', async () => {
  read.mockResolvedValue({ ok: true, dataUrl: 'data:image/png;base64,AA==' });
  const view = render(<LibraryAssetPreview doc={doc} />);
  expect(view.getByRole('status').textContent).toContain('Loading');
  expect((await view.findByRole('img')).getAttribute('src')).toBe('data:image/png;base64,AA==');
  expect(read).toHaveBeenCalledWith('project', 'a.png', 'p');
  read.mockResolvedValue({ ok: true, dataUrl: 'data:application/pdf;base64,AA==' });
  view.rerender(<LibraryAssetPreview doc={{ ...doc, scope: undefined, projectId: undefined, relPath: 'a.pdf', kind: 'pdf' }} />);
  expect((await view.findByTitle('Shared image')).getAttribute('src')).toBe('data:application/pdf;base64,AA==');
  expect(read).toHaveBeenLastCalledWith('global', 'a.pdf', undefined); expect(view.container.querySelector('webview')).toBeNull();
});
it('shows errors and missing assets without an unsafe fallback', async () => {
  read.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ok: false, message: 'File too big' }).mockResolvedValueOnce({ ok: true });
  const view = render(<LibraryAssetPreview doc={doc} />); await view.findByText('Library preview is unavailable. Reconnect and try again.');
  view.rerender(<LibraryAssetPreview doc={{ ...doc, relPath: 'b.png' }} />); await view.findByText('File too big');
  view.rerender(<LibraryAssetPreview doc={{ ...doc, relPath: 'c.png' }} />); await view.findByText('Library preview is unavailable');
  expect(view.queryByRole('img')).toBeNull();
});
it('ignores old results and failures after another selection or unmount', async () => {
  let resolve!: (value: FsReadDataUrlResult) => void, reject!: (error: Error) => void;
  read.mockImplementationOnce(() => new Promise<FsReadDataUrlResult>(r => { resolve = r; }))
    .mockResolvedValueOnce({ ok: true, dataUrl: 'data:image/png;base64,new' })
    .mockImplementationOnce(() => new Promise((_r, e) => { reject = e; }));
  const view = render(<LibraryAssetPreview doc={doc} />);
  view.rerender(<LibraryAssetPreview doc={{ ...doc, relPath: 'b.png' }} />);
  await view.findByRole('img'); resolve({ ok: true, dataUrl: 'data:image/png;base64,old' });
  await Promise.resolve(); expect(view.getByRole('img').getAttribute('src')).toBe('data:image/png;base64,new');
  view.rerender(<LibraryAssetPreview doc={{ ...doc, relPath: 'c.png' }} />); view.unmount(); reject(new Error('old failure')); await Promise.resolve();
});
