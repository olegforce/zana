// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { InteriorDetails } from './interior-view.js';
import { buildingInterior } from './interior.js';
import { cityBuildings, projectCity } from './model.js';
afterEach(cleanup);
it('shows real schedule states on the board and sends their opaque keys to the host inspector', () => {
  const schedules = [
    { key: 'planned', projectId: 'p', title: 'Future job', enabled: true, running: false, nextRunAt: '2026-10-04T14:00:00Z' },
    { key: 'running', projectId: 'p', title: 'Active job', enabled: true, running: true, nextRunAt: null },
    { key: 'paused', projectId: 'p', title: 'Paused job', enabled: false, running: false, nextRunAt: null }
  ];
  const building = cityBuildings(projectCity({ projects: [{ id: 'p', name: 'P' }], members: [], schedules, executions: [], searchQuery: '' }), new Map())[0];
  const inspect = vi.fn(); render(<InteriorDetails model={buildingInterior(building)} onInspect={inspect}/>);
  expect(screen.getByText('Running')).toBeTruthy(); expect(screen.getByText('Paused')).toBeTruthy();
  expect(screen.getByRole('group', { name: 'Agents on this floor' }).querySelectorAll('button')).toHaveLength(2);
  expect(screen.getAllByRole('button', { name: /^Worker .*Scheduled plan$/ })).toHaveLength(2);
  expect(screen.getByText('Schedule board · 3 plans').closest('details')?.open).toBe(true);
  for (const schedule of schedules) { fireEvent.click(screen.getByRole('button', { name: `Schedule board: ${schedule.title}` })); expect(inspect).toHaveBeenLastCalledWith(schedule.key); }
  fireEvent.click(screen.getByRole('button', { name: 'Worker Future job, Scheduled plan' })); expect(inspect).toHaveBeenLastCalledWith('planned');
});
