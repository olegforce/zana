// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LibraryRootAvailability } from '@zana-ai/zcc-domain/product';
const state = vi.hoisted(() => ({ roots: [] as LibraryRootAvailability[] | undefined, error: undefined as string | undefined, refresh: vi.fn() }));
vi.mock('@/store', () => ({ useLibrary: (select: (value: typeof state) => unknown) => select(state) }));
import { LibraryAvailability } from './LibraryAvailability.js';
afterEach(cleanup);
beforeEach(() => { state.roots = []; state.error = undefined; state.refresh.mockClear(); });
it('names unavailable owners and offers a retry without hiding other projects', () => {
  state.roots = [
    { scope: 'global', state: 'offline' },
    { scope: 'project', projectId: 'a', projectName: 'Alpha', state: 'unavailable' },
    { scope: 'project', projectId: 'b', state: 'limit' },
    { scope: 'project', projectId: 'c', projectName: 'Ready', state: 'ready' }
  ];
  const view = render(<LibraryAvailability />);
  expect(view.getByRole('status').textContent).toContain('Global Library: storage machine is offline');
  expect(view.getByRole('status').textContent).toContain('Alpha: documents are temporarily unavailable');
  expect(view.getByRole('status').textContent).toContain('Project Library: document listing limit reached');
  expect(view.getByRole('status').textContent).not.toContain('Ready');
  fireEvent.click(view.getByRole('button', { name: 'Retry Library' })); expect(state.refresh).toHaveBeenCalledOnce();
  view.rerender(<LibraryAvailability projectId="a" />); expect(view.getByRole('status').textContent).not.toContain('limit reached');
  expect(view.getByRole('status').textContent).toContain('Global Library');
  view.rerender(<LibraryAvailability projectId="a" scope="project" />); expect(view.getByRole('status').textContent).not.toContain('Global Library');
  view.rerender(<LibraryAvailability scope="global" />); expect(view.getByRole('status').textContent).not.toContain('Alpha');
});
it('hides a healthy state, scopes unrelated failures, and shows a failed refresh', () => {
  state.roots = undefined;
  const view = render(<LibraryAvailability projectId="a" />); expect(view.queryByRole('status')).toBeNull();
  state.roots = [{ scope: 'project', projectId: 'b', state: 'offline' }];
  view.rerender(<LibraryAvailability projectId="a" />); expect(view.queryByRole('status')).toBeNull();
  state.error = 'Reconnect and try again'; view.rerender(<LibraryAvailability projectId="a" />);
  expect(view.getByRole('status').textContent).toContain('Reconnect and try again');
});
