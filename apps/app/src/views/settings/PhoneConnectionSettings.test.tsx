// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PhoneConnectionSettings } from './PhoneConnectionSettings.js';
const configure = vi.fn();
vi.mock('../../lib/product-client.js', () => ({ product: { mobile: { configure: (...args: unknown[]) => configure(...args) } } }));
afterEach(cleanup);
beforeEach(() => { configure.mockReset().mockResolvedValue(undefined); });
const status = { running: true, publicUrl: null, host: null, port: null, boundLan: false, error: null };
it('defaults to local and saves without remote settings', async () => {
  const onSaved = vi.fn(async () => {}); render(<PhoneConnectionSettings status={null} onSaved={onSaved} />);
  expect((screen.getByLabelText('Connection method') as HTMLSelectElement).value).toBe('local');
  fireEvent.click(screen.getByText('Save connection'));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(configure).toHaveBeenCalledWith({ mode: 'local' }); expect(screen.getByText('Connection saved.')).toBeTruthy();
});
it('explains Tailscale setup and saves its URL', async () => {
  render(<PhoneConnectionSettings status={null} onSaved={async () => {}} />);
  fireEvent.change(screen.getByLabelText('Connection method'), { target: { value: 'tailscale' } });
  expect(screen.getByText(/tailscale serve --bg/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Tailscale HTTPS address'), { target: { value: ' https://mac.test.ts.net ' } });
  fireEvent.click(screen.getByText('Save connection'));
  await waitFor(() => expect(configure).toHaveBeenCalledWith({ mode: 'tailscale', publicUrl: 'https://mac.test.ts.net' }));
});
it('keeps a saved relay secret hidden and clears a replacement after saving', async () => {
  render(<PhoneConnectionSettings status={{ ...status, relayState: 'connected', connection: { mode: 'relay', publicUrl: 'https://one.test', hasRelayToken: true } }} onSaved={async () => {}} />);
  expect(screen.getByText('Relay connected')).toBeTruthy();
  const input = screen.getByLabelText('Relay secret') as HTMLInputElement;
  expect(input.type).toBe('password'); expect(input.value).toBe('');
  fireEvent.change(input, { target: { value: 'replacement' } });
  await act(async () => fireEvent.click(screen.getByText('Save connection')));
  expect(input.value).toBe('');
  expect(configure).toHaveBeenCalledWith({ mode: 'relay', publicUrl: 'https://one.test', relayToken: 'replacement' });
});
it('surfaces errors and leaves the form available for correction', async () => {
  configure.mockRejectedValue(new Error('Enter the relay secret'));
  render(<PhoneConnectionSettings status={{ ...status, relayState: 'reconnecting', connection: { mode: 'relay', publicUrl: 'https://one.test', hasRelayToken: false } }} onSaved={async () => {}} />);
  expect(screen.getByText(/Connecting to relay/)).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByText('Save connection')));
  expect(screen.getByRole('alert').textContent).toBe('Enter the relay secret');
  expect((screen.getByText('Save connection') as HTMLButtonElement).disabled).toBe(false);
  fireEvent.change(screen.getByLabelText('Connection method'), { target: { value: 'local' } });
  expect(screen.queryByLabelText('Relay secret')).toBeNull();
});
