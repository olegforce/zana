// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ComputerCode } from './ComputerCode';
const code = '0123-4567-89AB-CDEF';
const server = { id: 'reserved', browserUrl: 'https://my-mac.example.com', paired: false, live: false, revoked: false };
let api: any, onError: any, onChanged: any;
const view = (computers: any[] = []) => render(<ComputerCode api={api} onError={onError} onChanged={onChanged} domain="example.com" computers={computers} />);
beforeEach(() => {
  vi.useFakeTimers();
  api = vi.fn(async (path: string) => path === '/account' ? { servers: [server] } : ({ code, serverId: server.id, browserUrl: server.browserUrl, expiresAt: Date.now() + 600_000 }));
  onError = vi.fn(); onChanged = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => {}) } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
const click = async (name: string) => act(async () => fireEvent.click(screen.getByRole('button', { name })));
it('reserves the address before showing a code, copies it and observes registration then live connection', async () => {
  const mounted = view();
  expect((screen.getByRole('button', { name: 'Reserve address and get code' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Your address'), { target: { value: 'My-Mac' } });
  await click('Reserve address and get code');
  expect(api).toHaveBeenCalledWith('/computer/reserve', { label: 'my-mac' });
  expect(screen.getByText(code)).toBeTruthy(); expect(screen.getByText(server.browserUrl)).toBeTruthy();
  await click('Copy code'); expect(navigator.clipboard.writeText).toHaveBeenCalledWith(code); expect(screen.getByText('Copied')).toBeTruthy();
  api.mockResolvedValue({ servers: [{ ...server, paired: true }] });
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(screen.getByRole('status').textContent).toContain('registered'); expect(screen.queryByText(code)).toBeNull();
  api.mockResolvedValue({ servers: [{ ...server, paired: true, live: true }] });
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(screen.getByRole('link', { name: 'Open Zana' }).getAttribute('href')).toBe(server.browserUrl);
  const calls = api.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(9000)); expect(api).toHaveBeenCalledTimes(calls);
  expect(onChanged).toHaveBeenCalledTimes(2); mounted.unmount(); expect(vi.getTimerCount()).toBe(0);
});
it('resumes an existing reservation and renews expired codes for the same instance', async () => {
  view([server]); await act(async () => {});
  await click('Get a connect code'); expect(api).toHaveBeenCalledWith('/computer/code', { serverId: server.id });
  await act(async () => vi.advanceTimersByTimeAsync(600_000));
  expect(screen.queryByText(code)).toBeNull(); expect(screen.getByRole('status').textContent).toContain('expired');
  await click('Get a new code'); expect(screen.getByText(code)).toBeTruthy();
});
it('reports reservation and clipboard errors, blocks duplicate generation and retries polling', async () => {
  let reject!: (error: Error) => void;
  api.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  view(); fireEvent.change(screen.getByLabelText('Your address'), { target: { value: 'my-mac' } });
  fireEvent.click(screen.getByRole('button', { name: 'Reserve address and get code' }));
  expect((screen.getByRole('button', { name: 'Reserving…' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => reject(new Error('Taken'))); expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Taken' }));
  await click('Reserve address and get code');
  vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('Denied')); await click('Copy code');
  expect(onError).toHaveBeenLastCalledWith(expect.objectContaining({ message: expect.stringContaining('Could not copy') }));
  api.mockRejectedValueOnce(new Error('Offline'));
  await act(async () => vi.advanceTimersByTimeAsync(3000)); expect(screen.getByRole('status').textContent).toContain('Retrying');
  await act(async () => vi.advanceTimersByTimeAsync(3000)); expect(screen.getByRole('status').textContent).toContain('Waiting for your computer');
});
it('lets the user finish another reservation and ignores late responses after unmount', async () => {
  const mounted = view([server, { ...server, id: 'second', browserUrl: 'https://second.example.com' }]);
  await act(async () => {});
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'second' } });
  await act(async () => {}); await click('Get a connect code');
  expect(api).toHaveBeenCalledWith('/computer/code', { serverId: 'second' });
  let resolve!: (value: unknown) => void;
  api.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await act(async () => vi.advanceTimersByTimeAsync(3000)); mounted.unmount();
  await act(async () => resolve({ servers: [{ ...server, id: 'second', live: true }] }));
  expect(vi.getTimerCount()).toBe(0);
});
it('labels separate-instance creation when a computer is already paired', () => {
  view([{ ...server, paired: true }]);
  expect(screen.getByRole('heading').textContent).toBe('Create a separate Zana instance');
});
