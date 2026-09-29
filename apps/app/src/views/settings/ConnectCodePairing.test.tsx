// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConnectCodePairing } from './ConnectCodePairing.js';
const redeem = vi.hoisted(() => vi.fn());
vi.mock('../../lib/product-client.js', () => ({ product: { mobile: { redeemComputerCode: redeem } } }));
const code = '0123-4567-89AB-CDEF';
const fill = (value = code) => fireEvent.change(screen.getByLabelText('Connect code'), { target: { value } });
beforeEach(() => { vi.useFakeTimers(); redeem.mockResolvedValue(undefined); });
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers(); });

it('opens the account dashboard and automatically redeems a complete pasted code once', async () => {
  const onPaired = vi.fn(async () => {}); render(<ConnectCodePairing onPaired={onPaired} />);
  expect(screen.getByRole('link', { name: 'Get a connect code' }).getAttribute('href')).toBe('https://zana-ide.com/connect/');
  expect((screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement).disabled).toBe(true);
  fill('0123'); await act(async () => vi.advanceTimersByTimeAsync(500)); expect(redeem).not.toHaveBeenCalled();
  fill(` ${code.toLowerCase()} `); await act(async () => vi.advanceTimersByTimeAsync(350));
  expect(redeem).toHaveBeenCalledExactlyOnceWith('https://zana-ide.com', '0123456789ABCDEF');
  expect(onPaired).toHaveBeenCalledOnce();
  expect((screen.getByLabelText('Connect code') as HTMLInputElement).value).toBe('');
});
it('allows immediate manual submission, blocks duplicates, and clears scheduled work on unmount', async () => {
  let finish!: () => void;
  redeem.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const onPaired = vi.fn(async () => {}), mounted = render(<ConnectCodePairing onPaired={onPaired} />);
  fill(); fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  expect((screen.getByLabelText('Connect code') as HTMLInputElement).disabled).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(500)); expect(redeem).toHaveBeenCalledOnce();
  await act(async () => finish()); mounted.unmount();
  const second = render(<ConnectCodePairing onPaired={onPaired} />); fill(); second.unmount();
  await act(async () => vi.advanceTimersByTimeAsync(1000)); expect(redeem).toHaveBeenCalledOnce();
});
it('shows failed redemption without looping and permits an explicit retry', async () => {
  const onPaired = vi.fn(async () => {});
  redeem.mockRejectedValueOnce(new Error('Code expired')).mockRejectedValueOnce('offline');
  render(<ConnectCodePairing onPaired={onPaired} />); fill();
  await act(async () => vi.advanceTimersByTimeAsync(350));
  expect(screen.getByRole('alert').textContent).toBe('Code expired'); expect(onPaired).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(5000)); expect(redeem).toHaveBeenCalledOnce();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Connect' })));
  expect(screen.getByRole('alert').textContent).toContain('Could not connect');
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Connect' })));
  expect(onPaired).toHaveBeenCalledOnce();
});
it('uses a custom HTTPS account origin and never puts unsafe URLs in the dashboard link', async () => {
  render(<ConnectCodePairing onPaired={async () => {}} />);
  const service = screen.getByLabelText('Connect service');
  for (const value of ['not a url', 'javascript:alert(1)', 'http://test', 'https://user:pass@test/', 'https://test/path', 'https://test/?q=1', 'https://test/#hash']) {
    fireEvent.change(service, { target: { value } });
    expect(screen.getByRole('link', { name: 'Get a connect code' }).getAttribute('href')).toBe('https://zana-ide.com/connect/');
  }
  fireEvent.change(service, { target: { value: ' https://private.example ' } }); fill();
  expect(screen.getByRole('link', { name: 'Get a connect code' }).getAttribute('href')).toBe('https://private.example/connect/');
  await act(async () => vi.advanceTimersByTimeAsync(350));
  expect(redeem).toHaveBeenCalledWith('https://private.example', '0123456789ABCDEF');
});
