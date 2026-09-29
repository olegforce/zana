/** @vitest-environment happy-dom */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { LibraryDoc } from '@zana-ai/zcc-domain/product';
import { LibrarySaveRecovery } from './LibrarySaveRecovery.js';
const read = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/product-client.js', () => ({ product: { library: { read } } }));
const doc = { id: 'note', relPath: 'note.md', scope: 'project', projectId: 'p' } as LibraryDoc;
afterEach(() => { cleanup(); vi.resetAllMocks(); });
function mount(extra: Record<string, unknown> = {}) {
  const onSaveMerged = vi.fn(async () => {}), onUseLatest = vi.fn();
  return { onSaveMerged, onUseLatest, ...render(<LibrarySaveRecovery doc={doc} draft="my draft" message="Changed elsewhere." saving={false} onSaveMerged={onSaveMerged} onUseLatest={onUseLatest} {...extra} />) };
}
it('keeps both versions and requires an explicit save against the reviewed revision', async () => {
  read.mockResolvedValue({ ok: true, content: 'other machine edit', sha256: 'b'.repeat(64) });
  const view = mount();
  expect(read).not.toHaveBeenCalled();
  expect(view.queryByRole('button', { name: 'Save merged draft' })).toBeNull();
  fireEvent.click(view.getByRole('button', { name: 'Review latest version' }));
  await view.findByText('other machine edit');
  expect(read).toHaveBeenCalledWith('project', 'note.md', 'p');
  expect(view.onSaveMerged).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole('button', { name: 'Save merged draft' }));
  expect(view.onSaveMerged).toHaveBeenCalledWith('b'.repeat(64));
  fireEvent.click(view.getByRole('button', { name: 'Discard draft and use latest' }));
  expect(view.onUseLatest).toHaveBeenCalledWith('other machine edit', 'b'.repeat(64));
});
it.each([{ ok: false, message: 'Storage host offline' }, { ok: true, content: 'no revision' }, { ok: true, sha256: 'b' }])('cannot adopt an unavailable or unversioned read: %j', async result => {
  read.mockResolvedValue(result);
  const view = mount({ doc: { ...doc, scope: undefined, projectId: undefined } });
  fireEvent.click(view.getByRole('button', { name: 'Review latest version' }));
  await waitFor(() => expect(view.getByRole('status').textContent).toMatch(/offline|unavailable/));
  expect(view.queryByRole('button', { name: 'Save merged draft' })).toBeNull();
  expect(read).toHaveBeenCalledWith('global', 'note.md', undefined);
});
it('allows retry after a rejected read', async () => {
  read.mockRejectedValueOnce('disconnected').mockResolvedValueOnce({ ok: true, content: '', sha256: 'r' });
  const view = mount(); fireEvent.click(view.getByRole('button', { name: 'Review latest version' }));
  await view.findByText('disconnected'); fireEvent.click(view.getByRole('button', { name: 'Review latest version' }));
  await view.findByRole('button', { name: 'Save merged draft' });
});
it('copies the exact unsaved draft and reports clipboard failure without losing it', async () => {
  const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('denied'));
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const view = mount(); fireEvent.click(view.getByRole('button', { name: 'Copy draft' }));
  await view.findByText('Draft copied.'); expect(writeText).toHaveBeenCalledWith('my draft');
  fireEvent.click(view.getByRole('button', { name: 'Copy draft' }));
  await view.findByText(/Could not copy/); expect(view.onUseLatest).not.toHaveBeenCalled();
});
it.each(['read', 'copy'] as const)('fences a late %s response after changing documents', async action => {
  let resolve!: (value: any) => void;
  const pending = new Promise(done => { resolve = done; });
  read.mockReturnValue(pending);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => pending } });
  const view = mount(); fireEvent.click(view.getByRole('button', { name: action === 'read' ? 'Review latest version' : 'Copy draft' }));
  view.rerender(<LibrarySaveRecovery doc={{ ...doc, id: 'second', relPath: 'second.md' }} draft="second draft" message="Second conflict" saving={false} onSaveMerged={view.onSaveMerged} onUseLatest={view.onUseLatest} />);
  await act(async () => { resolve({ ok: true, content: 'stale content', sha256: 'r' }); });
  expect(view.queryByText('stale content')).toBeNull(); expect(view.queryByText('Draft copied.')).toBeNull();
});
it('disables review and replacement actions while a save is pending', async () => {
  read.mockResolvedValue({ ok: true, content: 'latest', sha256: 'r' });
  const view = mount(); fireEvent.click(view.getByRole('button', { name: 'Review latest version' })); await view.findByText('latest');
  view.rerender(<LibrarySaveRecovery doc={doc} draft="my draft" message="Changed elsewhere." saving onSaveMerged={view.onSaveMerged} onUseLatest={view.onUseLatest} />);
  for (const name of ['Review latest version', 'Save merged draft', 'Discard draft and use latest']) expect((view.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
});
