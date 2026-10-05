// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SearchPanel } from './SearchPanel';

const mocks = vi.hoisted(() => ({ search: vi.fn(), toast: vi.fn(), navigate: vi.fn() }));
vi.mock('../lib/product-client.js', () => ({ product: { fs: { searchFiles: mocks.search } } }));
vi.mock('../store.js', () => ({ useUi: (selector: (state: unknown) => unknown) => selector({
  setExplorerFile: mocks.navigate, setProjectView: mocks.navigate,
  requestExplorerGoto: mocks.navigate, pushToast: mocks.toast
}) }));
const project = { id: 'p', name: 'Project', path: '/project', createdAt: 0, lastActiveAt: 0 };
const hit = (text: string) => ({ hits: [{ path: '/project/file.txt', line: 1, column: 1, match: text, preview: text }], truncated: false });
const deferred = () => {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
afterEach(() => { cleanup(); vi.useRealTimers(); mocks.search.mockReset(); mocks.toast.mockReset(); });

it('drops a successful response after the query was cleared', async () => {
  vi.useFakeTimers();
  const pending = deferred(); mocks.search.mockReturnValue(pending.promise);
  const { container } = render(<SearchPanel project={project} onClose={() => {}} />);
  const input = screen.getByRole('textbox'); fireEvent.change(input, { target: { value: 'old' } });
  await act(() => vi.advanceTimersByTimeAsync(220)); expect(mocks.search).toHaveBeenCalledOnce();
  fireEvent.change(input, { target: { value: '' } });
  await act(async () => { pending.resolve(hit('old')); await pending.promise; });
  expect(container.querySelectorAll('.search-item')).toHaveLength(0);
  expect(mocks.toast).not.toHaveBeenCalled();
});

it('debounces rapid edits and ignores an older failure after a newer query succeeds', async () => {
  vi.useFakeTimers();
  const first = deferred(); mocks.search.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ hits: [], truncated: false });
  render(<SearchPanel project={project} onClose={() => {}} />);
  const input = screen.getByRole('textbox'); fireEvent.change(input, { target: { value: 'first' } });
  await act(() => vi.advanceTimersByTimeAsync(220));
  fireEvent.change(input, { target: { value: 'second' } });
  fireEvent.change(input, { target: { value: 'latest' } });
  await act(() => vi.advanceTimersByTimeAsync(220));
  expect(mocks.search).toHaveBeenCalledTimes(2);
  expect(mocks.search).toHaveBeenLastCalledWith('/project', 'latest', { caseSensitive: false, regex: false });
  await act(async () => { first.reject(Error('old failure')); await first.promise.catch(() => {}); });
  expect(mocks.toast).not.toHaveBeenCalled();
});

it('discards a pending response on unmount', async () => {
  vi.useFakeTimers(); const pending = deferred(); mocks.search.mockReturnValue(pending.promise);
  const view = render(<SearchPanel project={project} onClose={() => {}} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'pending' } });
  await act(() => vi.advanceTimersByTimeAsync(220)); view.unmount();
  await act(async () => { pending.reject(Error('late error')); await pending.promise.catch(() => {}); });
  expect(mocks.toast).not.toHaveBeenCalled();
});
