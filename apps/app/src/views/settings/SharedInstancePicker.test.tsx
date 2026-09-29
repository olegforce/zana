// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const client = vi.hoisted(() => ({ signIn: vi.fn(), list: vi.fn(), select: vi.fn() }));
vi.mock('../../lib/product-client.js', () => ({ product: { sharedClient: client } }));
import { SharedInstancePicker } from './SharedInstancePicker.js';
beforeEach(() => {
  vi.resetAllMocks();
  client.list.mockResolvedValue([{ id: 'owned', name: 'My Zana', url: 'https://owned.zana-ide.com', online: true }]);
});
afterEach(cleanup);
it('guides browser sign-in, loads instances on completion, and opens the selection', async () => {
  let complete!: () => void;
  client.signIn.mockImplementation(() => new Promise<void>(resolve => { complete = resolve; }));
  render(<SharedInstancePicker />);
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(screen.getByRole('status').textContent).toContain('your browser');
  expect((screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement).disabled).toBe(true);
  expect(client.list).not.toHaveBeenCalled();
  complete(); await screen.findByText('My Zana');
  expect(screen.queryByRole('status')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Open instance' }));
  await waitFor(() => expect(client.select).toHaveBeenCalledWith('owned'));
});
it('shows errors, allows retry, and still supports manual refresh', async () => {
  client.signIn.mockRejectedValueOnce(new Error('Browser unavailable'));
  render(<SharedInstancePicker />); fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Browser unavailable');
  expect(screen.queryByRole('status')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh instances' }));
  await screen.findByText('My Zana'); expect(screen.queryByRole('alert')).toBeNull();
});
it('handles a non-Error failure and displays offline instances on retry', async () => {
  client.signIn.mockRejectedValueOnce('unavailable');
  client.list.mockResolvedValueOnce([{ id: 'offline', name: 'Offline Zana', url: 'https://offline.zana-ide.com', online: false }]);
  render(<SharedInstancePicker />); fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Could not open shared Zana');
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByText('Offline'); expect(screen.queryByRole('alert')).toBeNull();
});
