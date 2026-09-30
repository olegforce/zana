// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MobileAgentsBack } from './MobileAgentsBack.js';

const viewport = vi.hoisted(() => ({ compact: true }));
vi.mock('../hooks/useCompactLayout.js', () => ({ useCompactLayout: () => viewport.compact }));
beforeEach(() => { viewport.compact = true; });
afterEach(cleanup);

function Location() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

it.each([
  ['/threads/t1', '/agents'],
  ['/sessions/s1', '/agents'],
  ['/projects/p1/threads/t1', '/projects/p1'],
  ['/projects/p1/sessions/s1', '/projects/p1']
])('returns directly from %s to %s without a previous history entry', (from, to) => {
  render(<MemoryRouter initialEntries={[from]}><MobileAgentsBack /><Location /></MemoryRouter>);
  const back = screen.getByRole('link', { name: 'Back to agents' });
  expect(back.getAttribute('href')).toBe(to);
  fireEvent.click(back);
  expect(screen.getByTestId('location').textContent).toBe(to);
  expect(screen.queryByRole('link', { name: 'Back to agents' })).toBeNull();
});

it.each(['/agents', '/projects/p1', '/threads/new', '/projects/p1/threads/new', '/settings/global', '/inbox', '/'])
('does not add a return control on %s', (path) => {
  render(<MemoryRouter initialEntries={[path]}><MobileAgentsBack /></MemoryRouter>);
  expect(screen.queryByRole('link', { name: 'Back to agents' })).toBeNull();
});

it('keeps desktop navigation unchanged and hides the link while the drawer is open', () => {
  viewport.compact = false;
  const { rerender } = render(<MemoryRouter initialEntries={['/threads/t1']}><MobileAgentsBack /></MemoryRouter>);
  expect(screen.queryByRole('link', { name: 'Back to agents' })).toBeNull();
  viewport.compact = true;
  rerender(<MemoryRouter initialEntries={['/threads/t1']}><MobileAgentsBack hidden /></MemoryRouter>);
  expect(screen.queryByRole('link', { name: 'Back to agents' })).toBeNull();
  rerender(<MemoryRouter initialEntries={['/threads/t1']}><MobileAgentsBack /></MemoryRouter>);
  expect(screen.getByRole('link', { name: 'Back to agents' })).toBeTruthy();
});
