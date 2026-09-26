// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { MobileSidebarNav } from './MobileSidebarNav.js';
import type { SidebarRailItem } from './SidebarRail.js';
import { PROJECTS_SECTION_SORT_ID, PROJECT_SESSIONS_SECTION_SORT_ID } from './sidebarNavOrder.js';

afterEach(cleanup);
const row = (id: string, label: string): SidebarRailItem => ({ kind: 'row', id, label, icon: null, to: `/${id}`, testId: id, active: false });
const projects: SidebarRailItem = { kind: 'section', id: PROJECTS_SECTION_SORT_ID, node: <div /> };
const renderItem = (id: string) => <button key={id}>{id}</button>;
const items = [row('home', 'New Chat'), row('inbox', 'Inbox'), row('agents', 'Agents'), row('docs', 'Documents'), row('acme/review', 'Review'), projects];

it('shows all tool and plugin destinations immediately without duplicating the main shortcuts', () => {
  render(<MobileSidebarNav items={items} navAriaLabel="Main navigation" renderItem={renderItem} />);
  expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeTruthy();
  for (const id of ['agents', 'docs', 'acme/review']) expect(screen.getByRole('button', { name: id })).toBeTruthy();
  for (const id of ['home', 'inbox', 'More']) expect(screen.queryByRole('button', { name: id })).toBeNull();
  expect(screen.queryByRole('button', { name: PROJECTS_SECTION_SORT_ID })).toBeNull();
  expect(screen.getByRole('button', { name: 'Projects', exact: true })).toBeTruthy();
});

it('searches labels and plugin identifiers, handles no matches, and returns focus when cleared', () => {
  render(<MobileSidebarNav items={items} navAriaLabel="Main navigation" renderItem={renderItem} />);
  const search = screen.getByRole('searchbox', { name: 'Search plugins and tools' });
  fireEvent.change(search, { target: { value: ' DOCUMENTS ' } });
  expect(screen.getByRole('button', { name: 'docs' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'agents' })).toBeNull();
  fireEvent.change(search, { target: { value: 'ACME' } });
  expect(screen.getByRole('button', { name: 'acme/review' })).toBeTruthy();
  fireEvent.change(search, { target: { value: 'missing' } });
  expect(screen.getByRole('status').textContent).toContain('No plugins or tools match');
  fireEvent.click(screen.getByRole('button', { name: 'Clear tools search' }));
  expect(search).toBe(document.activeElement);
  expect((search as HTMLInputElement).value).toBe('');
  expect(screen.getByRole('button', { name: 'docs' })).toBeTruthy();
});

it.each([
  [PROJECTS_SECTION_SORT_ID, 'Projects'],
  [PROJECT_SESSIONS_SECTION_SORT_ID, 'Project agents']
])('opens %s separately and restores picker focus and search when returning', (id, label) => {
  render(<MobileSidebarNav items={[...items.filter(item => item.kind === 'row'), { ...projects, id }]} navAriaLabel="Nav" renderItem={renderItem} />);
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'project' } });
  fireEvent.click(screen.getByRole('button', { name: label, exact: true }));
  const back = screen.getByRole('button', { name: 'Plugins & tools' });
  expect(back).toBe(document.activeElement);
  expect(screen.getByRole('button', { name: id })).toBeTruthy();
  expect(screen.queryByRole('searchbox')).toBeNull();
  fireEvent.click(back);
  expect(screen.getByRole('button', { name: label, exact: true })).toBe(document.activeElement);
  expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('project');
});

it('handles an empty catalog and reacts to plugins arriving or disappearing', () => {
  const { rerender } = render(<MobileSidebarNav items={[]} navAriaLabel="Nav" renderItem={renderItem} />);
  expect(screen.getByRole('status').textContent).toBe('No tools available yet.');
  rerender(<MobileSidebarNav items={[row('new-plugin', 'New plugin')]} navAriaLabel="Nav" renderItem={renderItem} />);
  expect(screen.getByRole('button', { name: 'new-plugin' })).toBeTruthy();
  rerender(<MobileSidebarNav items={[]} navAriaLabel="Nav" renderItem={renderItem} />);
  expect(screen.queryByRole('button', { name: 'new-plugin' })).toBeNull();
});
