// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { InstanceMachines } from './InstanceMachines';
afterEach(cleanup);
it('lists execution machines of the selected instance, excluding revoked grants', async () => {
  const api = vi.fn().mockResolvedValue({ machines: [{ id: 'a', name: 'Devbox', revoked: false }, { id: 'b', name: 'Old machine', revoked: true }] });
  const view = render(<InstanceMachines serverId="one/two" api={api} refreshRevision={0} />);
  expect(api).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Execution machines', { selector: 'summary' }));
  expect((await screen.findByText('Devbox · Enrolled')).textContent).toContain('Devbox');
  expect(screen.queryByText('Old machine', { exact: false })).toBeNull();
  expect(api).toHaveBeenCalledWith('/account/hosts?serverId=one%2Ftwo');
  expect(screen.getByText(/Settings → Machines/)).toBeTruthy();
  api.mockResolvedValue({ machines: [] });
  expect(screen.queryByRole('button')).toBeNull();
  view.rerender(<InstanceMachines serverId="one/two" api={api} refreshRevision={1} />);
  await screen.findByText('No additional machines enrolled yet.');
});
it('exposes failed requests and permits a retry without inventing an empty result', async () => {
  const api = vi.fn().mockRejectedValueOnce(new Error('Session expired')).mockRejectedValueOnce(null).mockResolvedValue({ machines: [] });
  const view = render(<InstanceMachines serverId="one" api={api} refreshRevision={0} />);
  fireEvent.click(screen.getByText('Execution machines', { selector: 'summary' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Session expired');
  expect(screen.getByRole('alert').textContent).toContain('Use Refresh above');
  expect(screen.queryByText(/No additional/)).toBeNull();
  view.rerender(<InstanceMachines serverId="one" api={api} refreshRevision={1} />);
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Could not load execution machines'));
  view.rerender(<InstanceMachines serverId="one" api={api} refreshRevision={2} />);
  await screen.findByText('No additional machines enrolled yet.');
  expect(screen.queryByRole('alert')).toBeNull();
});
it('ignores an outdated in-flight request after a newer refresh', async () => {
  let stale!: (value: any) => void;
  const api = vi.fn().mockImplementationOnce(() => new Promise(resolve => { stale = resolve; })).mockResolvedValue({ machines: [{ id: 'new', name: 'Current machine', revoked: false }] });
  const view = render(<InstanceMachines serverId="one" api={api} refreshRevision={0} />);
  fireEvent.click(screen.getByText('Execution machines', { selector: 'summary' }));
  await screen.findByRole('status');
  view.rerender(<InstanceMachines serverId="one" api={api} refreshRevision={1} />);
  await screen.findByText('Current machine · Enrolled');
  stale({ machines: [{ id: 'old', name: 'Outdated machine', revoked: false }] });
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  expect(screen.queryByText(/Outdated machine/)).toBeNull();
  expect(screen.getByText('Current machine · Enrolled')).toBeTruthy();
});
it('defers loading a collapsed section until it is expanded', async () => {
  const api = vi.fn().mockResolvedValue({ machines: [] });
  const view = render(<InstanceMachines serverId="one" api={api} refreshRevision={0} />);
  view.rerender(<InstanceMachines serverId="one" api={api} refreshRevision={1} />);
  expect(api).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Execution machines', { selector: 'summary' }));
  await screen.findByText('No additional machines enrolled yet.');
  expect(api).toHaveBeenCalledOnce();
});
