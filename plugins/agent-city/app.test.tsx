// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { PluginAgentsViewProps } from '@zana-ai/zcc-plugin-sdk/app';
vi.mock('./use-city.js', () => ({ useCityCanvas: () => ({ available: true, reduced: false, viewport: { width: 1120, height: 775 } }) }));
import definition, { AgentCity } from './city-app.js';
afterEach(cleanup);
function data(n = 3): PluginAgentsViewProps {
  return { projectId: null, projects: Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`, name: `Project ${i}` })),
    members: Array.from({ length: n }, (_, i) => ({ key: `agent:${i}`, title: `Agent ${i}`, projectId: 'p0', kind: 'agent', live: i !== 2, scheduled: i === 1, teamId: i === 1 ? 'team' : undefined, status: i === 0 ? 'needs-you' : i === 2 ? 'done' : 'working', detail: `Detail ${i}` })),
    schedules: [{ key: 'schedule:s', title: 'Nightly review', projectId: 'p0', enabled: true, running: false, nextRunAt: null }], executions: [{ key: 'execution:j', projectId: 'p0', title: 'Review team', state: 'RUNNING', needsAttention: true }], includeScheduled: true, searchQuery: '', onInspect: vi.fn() };
}
describe('Agent City interactions', () => {
  it('opens actual agents, schedules and team requests with opaque host keys', () => {
    const props = data(); render(<AgentCity {...props}/>); fireEvent.click(screen.getByRole('button', { name: /Project 0, / }));
    fireEvent.click(screen.getByRole('button', { name: /Agent 0 Detail/ })); expect(props.onInspect).toHaveBeenLastCalledWith('agent:0');
    fireEvent.click(screen.getByRole('button', { name: /Review requests/ }));
    fireEvent.click(screen.getByRole('button', { name: /Review team/ })); expect(props.onInspect).toHaveBeenLastCalledWith('execution:j');
    fireEvent.click(screen.getByRole('button', { name: /Scheduler station/ }));
    fireEvent.click(screen.getByRole('button', { name: /Nightly review/ })); expect(props.onInspect).toHaveBeenLastCalledWith('schedule:s');
    fireEvent.click(screen.getByRole('button', { name: /Done pavilion/ }));
    expect(screen.getByRole('button', { name: /Agent 2 Detail/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Agent 0 Detail/ })).toBeNull();
  });
  it('filters across projects and allows every member of a large population to be reached', () => {
    render(<AgentCity {...data(92)}/>); fireEvent.click(screen.getByRole('button', { name: /Project 0, / }));
    expect(screen.queryByRole('button', { name: /Agent 91 Detail/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Next roster page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next roster page' }));
    expect(screen.getByRole('button', { name: /Agent 91 Detail/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Previous roster page' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search this roster' }), { target: { value: 'Agent 91' } });
    expect(screen.getByRole('button', { name: /Agent 91 Detail/ })).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search this roster' }), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Needs you 1' }));
    expect(screen.getByRole('heading', { name: 'All agents' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Agent 0 Detail/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Agent 1 Detail/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /All 92/ }));
  });
  it('shows every project together, keeps them visible when inspecting, and grows without paging', () => {
    const props = { ...data(), projects: Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, name: `Project ${i}` })) };
    const { rerender } = render(<AgentCity {...props}/>);
    expect(screen.getByText('10 projects · one city')).toBeTruthy();
    expect(document.querySelectorAll('.city-label')).toHaveLength(10);
    expect(screen.queryByRole('button', { name: /district/i })).toBeNull();
    expect(screen.queryByRole('complementary')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Project 9, / }));
    expect(screen.getByRole('heading', { name: 'Project 9' })).toBeTruthy();
    expect(document.querySelectorAll('.city-label')).toHaveLength(10);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByLabelText('Map zoom level').textContent).toBe('125%');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(screen.getByLabelText('Map zoom level').textContent).toBe('100%');
    fireEvent.click(screen.getByRole('button', { name: 'Fit city' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close roster' }));
    expect(screen.queryByRole('complementary')).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: 'Find a project building' }), { target: { value: 'p6' } });
    expect(screen.getByRole('heading', { name: 'Project 6' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pause motion' }));
    expect(screen.getByRole('button', { name: 'Resume motion' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Resume motion' }));
    rerender(<AgentCity {...props} projects={[{ id: 'new', name: 'New arrival' }, ...props.projects]}/>);
    expect(document.querySelectorAll('.city-label')).toHaveLength(11);
    expect(screen.getByRole('heading', { name: 'Project 6' })).toBeTruthy();
    rerender(<AgentCity {...props} projects={props.projects.slice(0, 1)}/>);
    expect(screen.getByRole('heading', { name: 'All agents' })).toBeTruthy();
  });
  it('handles empty cities, filtered rosters, and hidden schedules honestly', () => {
    const props = { ...data(0), projects: [], schedules: [], executions: [] }; const { rerender } = render(<AgentCity {...props}/>); fireEvent.click(screen.getByRole('button', { name: 'All 0' }));
    expect(screen.getByText(/Start an agent to bring/)).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search this roster' }), { target: { value: 'missing' } });
    expect(screen.getByText('No matches in this roster.')).toBeTruthy();
    rerender(<AgentCity {...props} includeScheduled={false}/>);
    fireEvent.click(screen.getByRole('button', { name: /Scheduler station/ }));
    expect(screen.getByText(/calendar toggle/)).toBeTruthy();
    expect(screen.getByText('No schedules to display.')).toBeTruthy();
  });
  it('shows running and paused schedules without a fake ETA', () => {
    const props = data(); props.schedules = [...props.schedules, { key: 's2', title: 'Paused plan', projectId: 'p0', enabled: false, running: false, nextRunAt: null }, { key: 's3', title: 'Running plan', projectId: 'p0', enabled: true, running: true, nextRunAt: null }];
    render(<AgentCity {...props}/>); fireEvent.click(screen.getByRole('button', { name: /Scheduler station/ }));
    expect(within(screen.getByRole('button', { name: /Paused plan/ })).getByText('Paused')).toBeTruthy();
    expect(within(screen.getByRole('button', { name: /Running plan/ })).getByText('Running')).toBeTruthy();
  });
});

it('registers World on capable hosts and never adds a separate plugin navigation page', () => {
  const experimental_agentsView = vi.fn(), navPanel = vi.fn();
  definition.setup({ slots: { experimental_agentsView, navPanel } } as never);
  expect(experimental_agentsView).toHaveBeenCalledWith(expect.objectContaining({ id: 'world', title: 'World', component: AgentCity }));
  definition.setup({ slots: { navPanel } } as never);
  expect(navPanel).not.toHaveBeenCalled();
});
