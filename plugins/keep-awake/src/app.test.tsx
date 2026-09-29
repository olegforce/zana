// @vitest-environment jsdom
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import plugin from '../app.js';
let Component: React.ComponentType<{ pluginId: string }>;
const callRpc = vi.fn();
const machines = { machines: [{ id: 'a', name: 'First' }, { id: 'b', name: 'Second' }], primaryId: 'a' };
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
beforeEach(() => {
  vi.stubGlobal('__ZCC_HOST_REACT__', React);
  vi.stubGlobal('__ZCC_PLUGIN_HOST__', { callRpc });
  plugin.setup({ slots: { settingsSection: (slot: any) => { Component = slot.component; } } });
  callRpc.mockReset().mockImplementation(async (_plugin, method) => method === 'machines' ? machines : { awake: false });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('selects the primary, routes changes explicitly, and reflects successful updates', async () => {
  render(<Component pluginId="awake" />);
  await screen.findByText('This machine can sleep.');
  callRpc.mockResolvedValueOnce({ awake: true }); fireEvent.click(screen.getByRole('button', { name: 'Keep awake' }));
  await screen.findByText('This machine will stay awake.');
  expect(callRpc).toHaveBeenLastCalledWith('awake', 'set', { hostId: 'a', enable: true });
  fireEvent.click(screen.getByRole('button', { name: 'Allow sleep' }));
  await screen.findByText('This machine can sleep.');
  expect(callRpc).toHaveBeenLastCalledWith('awake', 'set', { hostId: 'a', enable: false });
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'b' } });
  await waitFor(() => expect(callRpc).toHaveBeenLastCalledWith('awake', 'status', { hostId: 'b' }));
});
it('ignores late status and mutations after changing machines', async () => {
  const oldStatus = deferred<{ awake: boolean }>(), oldMutation = deferred<{ awake: boolean }>();
  callRpc.mockImplementation(async (_plugin, method, args) => method === 'machines' ? machines : method === 'set' ? oldMutation.promise : args.hostId === 'a' ? oldStatus.promise : { awake: false });
  render(<Component pluginId="awake" />);
  await waitFor(() => expect(callRpc).toHaveBeenCalledWith('awake', 'status', { hostId: 'a' }));
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'b' } });
  await screen.findByText('This machine can sleep.');
  await act(async () => oldStatus.resolve({ awake: true }));
  expect(screen.queryByText('This machine will stay awake.')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Keep awake' }));
  expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'a' } });
  await screen.findByText('This machine will stay awake.');
  await act(async () => oldMutation.reject(new Error('Old B failure')));
  expect(screen.queryByRole('alert')).toBeNull();
  expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false);
});
it('shows offline and write errors without claiming a successful change', async () => {
  callRpc.mockImplementation(async (_plugin, method) => { if (method === 'machines') return machines; throw new Error('Machine offline'); });
  const view = render(<Component pluginId="awake" />);
  await screen.findByRole('alert'); expect(screen.getByRole('alert').textContent).toBe('Machine offline');
  expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  callRpc.mockResolvedValueOnce({ awake: false }); fireEvent.change(screen.getByRole('combobox'), { target: { value: 'b' } });
  await screen.findByText('This machine can sleep.');
  callRpc.mockRejectedValueOnce('Cannot keep awake'); fireEvent.click(screen.getByRole('button'));
  await screen.findByText('Cannot keep awake');
  view.unmount();
});
it('handles missing primary, failed enumeration, and unmount while loading', async () => {
  callRpc.mockResolvedValueOnce({ ...machines, primaryId: null });
  const view = render(<Component pluginId="awake" />); await screen.findByRole('option', { name: 'First' });
  expect(callRpc).toHaveBeenCalledTimes(1); view.unmount();
  callRpc.mockRejectedValueOnce(new Error('Cannot list machines'));
  const failed = render(<Component pluginId="awake" />); await screen.findByText('Cannot list machines'); failed.unmount();
  const pending = deferred<typeof machines>(); callRpc.mockReturnValueOnce(pending.promise);
  const waiting = render(<Component pluginId="awake" />); waiting.unmount();
  await act(async () => pending.resolve(machines));
});
