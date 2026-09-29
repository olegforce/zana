// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ goals: vi.fn(), scheduler: vi.fn() }));
vi.mock('../lib/product-client.js', () => ({ product: { goals: { reconcile: api.goals }, scheduler: { reconcile: api.scheduler } } }));
import { PendingWorkerRecovery } from './PendingWorkerRecovery.js';
afterEach(cleanup); beforeEach(() => { api.goals.mockReset(); api.scheduler.mockReset(); });
it.each(['goal', 'schedule'] as const)('checks the %s worker and explains an unknown outcome', async kind => {
  const call = kind === 'goal' ? api.goals : api.scheduler; call.mockResolvedValue({ ok: true, value: false });
  const view = render(<PendingWorkerRecovery kind={kind} id="record" sessionIds={['reserved-worker']} />);
  expect(view.getByRole('status').textContent).toContain('avoid starting the same work twice');
  expect(view.getByText('reserved-worker')).toBeTruthy();
  fireEvent.click(view.getByRole('button', { name: 'Check worker' })); fireEvent.click(view.getByRole('button'));
  await view.findByText(/worker is still unconfirmed/); expect(call).toHaveBeenCalledExactlyOnceWith('record');
});
it.each([{ ok: true, value: true }, { ok: false, message: 'Owner offline' }])('shows the authoritative outcome %j', async result => {
  api.goals.mockResolvedValue(result);
  const view = render(<PendingWorkerRecovery kind="goal" id="record" sessionIds={[]} />);
  expect(view.queryByText('Worker details')).toBeNull();
  fireEvent.click(view.getByRole('button')); await view.findByText(result.ok ? /Worker checked/ : 'Owner offline');
});
it('shows a failed connection and ignores results belonging to an old selection', async () => {
  let finish!: (result: unknown) => void;
  api.goals.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockRejectedValueOnce(new Error('disconnected'));
  const view = render(<PendingWorkerRecovery kind="goal" id="old" sessionIds={[]} />);
  fireEvent.click(view.getByRole('button')); expect((view.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  view.rerender(<PendingWorkerRecovery kind="goal" id="new" sessionIds={[]} />);
  await act(async () => finish({ ok: true, value: true })); expect(view.queryByText(/Worker checked/)).toBeNull();
  fireEvent.click(view.getByRole('button')); await view.findByText(/Could not reach/);
});
it('ignores a failed request after unmount', async () => {
  let fail!: (error: Error) => void;
  api.scheduler.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  const view = render(<PendingWorkerRecovery kind="schedule" id="record" sessionIds={[]} />);
  fireEvent.click(view.getByRole('button')); await waitFor(() => expect(api.scheduler).toHaveBeenCalledOnce()); view.unmount();
  await act(async () => fail(new Error('offline')));
});
