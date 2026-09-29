// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ read: vi.fn(), upload: vi.fn(), toast: vi.fn() }));
vi.mock('./library-import.js', () => ({ readLibraryImportFile: mocks.read }));
vi.mock('../../../lib/product-client.js', () => ({ product: { library: { importFile: mocks.upload } } }));
vi.mock('@/store', () => ({ useUi: (select: (state: { pushToast: typeof mocks.toast }) => unknown) => select({ pushToast: mocks.toast }) }));
import { LibraryImportButton } from './LibraryImportButton.js';
afterEach(cleanup);
beforeEach(() => { mocks.read.mockReset().mockResolvedValue('AP8='); mocks.upload.mockReset().mockResolvedValue({}); mocks.toast.mockReset(); });
function select(input: HTMLInputElement, name = 'photo.png') { fireEvent.change(input, { target: { files: [new File([new Uint8Array([0, 255])], name)] } }); }
it.each([undefined, 'original-project'])('imports once into the addressed Library (%s)', async projectId => {
  let done!: () => void; mocks.upload.mockImplementationOnce(() => new Promise<void>(resolve => { done = resolve; }));
  const view = render(<LibraryImportButton projectId={projectId} />), input = view.container.querySelector('input')!;
  const click = vi.spyOn(input, 'click');
  fireEvent.click(view.getByRole('button')); expect(click).toHaveBeenCalledOnce();
  fireEvent.change(input, { target: { files: [] } }); expect(mocks.read).not.toHaveBeenCalled();
  select(input); select(input);
  await waitFor(() => expect(mocks.upload).toHaveBeenCalledOnce());
  expect(mocks.upload).toHaveBeenCalledWith({ scope: projectId ? 'project' : 'global', projectId, relPath: 'photo.png', base64: 'AP8=' });
  expect((view.getByRole('button') as HTMLButtonElement).disabled).toBe(true); expect(input.value).toBe('');
  await act(async () => done());
  expect(mocks.toast).toHaveBeenCalledWith('Imported photo.png'); expect((view.getByRole('button') as HTMLButtonElement).disabled).toBe(false);
});
it.each([new Error('Library document already exists'), 'unexpected failure'])('shows import failures and lets the user select another file', async error => {
  mocks.upload.mockRejectedValueOnce(error);
  const view = render(<LibraryImportButton />), input = view.container.querySelector('input')!;
  select(input); await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(error instanceof Error ? error.message : 'File import failed', 'error'));
  select(input, 'another.png'); await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Imported another.png'));
});
it('cancels a pending read without uploading or showing a late toast', async () => {
  let finish!: (value: string) => void;
  mocks.read.mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve; }));
  const view = render(<LibraryImportButton />); select(view.container.querySelector('input')!);
  const signal = mocks.read.mock.calls[0]![1] as AbortSignal; view.unmount(); expect(signal.aborted).toBe(true);
  await act(async () => finish('AA=='));
  expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.toast).not.toHaveBeenCalled();
});
it.each([false, true])('ignores an already dispatched upload after unmount (failure: %s)', async failure => {
  let resolve!: () => void, reject!: (error: Error) => void;
  mocks.upload.mockImplementationOnce(() => new Promise<void>((a, b) => { resolve = a; reject = b; }));
  const view = render(<LibraryImportButton />); select(view.container.querySelector('input')!);
  await waitFor(() => expect(mocks.upload).toHaveBeenCalledOnce()); view.unmount();
  await act(async () => { if (failure) reject(new Error('offline')); else resolve(); });
  expect(mocks.toast).not.toHaveBeenCalled();
});
