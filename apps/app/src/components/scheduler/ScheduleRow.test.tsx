/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ScheduledTask } from '@zana-ai/zcc-domain/product';

const task = {
  id: 'sched-1',
  name: 'Morning digest',
  enabled: true,
  projectId: 'p1',
  profile: 'claude',
  schedule: { every: '1h' },
  overlap: 'skip',
  history: { retain: 10 },
  status: { runCount: 0, runs: [] },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z'
} as ScheduledTask;

vi.mock('../../store.js', () => ({
  useData: (selector: (s: { terminals: Record<string, never> }) => unknown) =>
    selector({ terminals: {} }),
  useUi: Object.assign(
    (selector: (s: { pushToast: () => void }) => unknown) => selector({ pushToast: vi.fn() }),
    { getState: () => ({ pushToast: vi.fn() }) }
  )
}));

vi.mock('../../lib/product-client.js', () => ({
  product: {
    scheduler: {
      setEnabled: vi.fn(),
      runNow: vi.fn()
    },
    terminals: { close: vi.fn() }
  }
}));

import { ScheduleRow } from './ScheduleRow.js';
import { MemoryRouter } from 'react-router-dom';

describe('ScheduleRow', () => {
  it('labels unconfirmed workers and disables repeat launch controls in the row and menu', () => {
    const pending = { ...task, enabled: false, status: { runCount: 0, runs: [{ at: new Date().toISOString(), result: 'skipped' as const, launchState: 'pending' as const, sessionId: 'reserved' }] } };
    const view = render(<MemoryRouter><ScheduleRow task={pending} projectName="Demo" onOpen={vi.fn()} onOpenInSplit={vi.fn()} onDuplicate={vi.fn()} onAskDelete={vi.fn()} /></MemoryRouter>);
    expect(view.getByText('needs checking')).toBeTruthy();
    expect((view.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    expect((view.getByRole('button', { name: 'Run now' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.contextMenu(view.container.querySelector('.scheduler-card-main')!);
    expect((view.getByRole('menuitem', { name: 'Run now' }) as HTMLButtonElement).disabled).toBe(true);
    expect((view.getByRole('menuitem', { name: 'Enable' }) as HTMLButtonElement).disabled).toBe(true);
  });
  afterEach(() => {
    cleanup();
  });

  it('opens the schedule on row click instead of expanding in place', () => {
    const onOpen = vi.fn();
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ScheduleRow
          task={task}
          projectName="Demo"
          onOpen={onOpen}
          onOpenInSplit={() => undefined}
          onDuplicate={() => undefined}
          onAskDelete={() => undefined}
        />
      </MemoryRouter>
    );
    expect(html).toContain('title="Open schedule"');
    expect(html).not.toContain('aria-expanded');
    expect(html).not.toContain('Show details');
    expect(html).not.toContain('Recent runs');

    render(
      <MemoryRouter>
        <ul>
          <ScheduleRow
            task={task}
            projectName="Demo"
            onOpen={onOpen}
            onOpenInSplit={() => undefined}
            onDuplicate={() => undefined}
            onAskDelete={() => undefined}
          />
        </ul>
      </MemoryRouter>
    );
    fireEvent.click(screen.getByTitle('Open schedule'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('offers Open in split from the row context menu', () => {
    const onOpenInSplit = vi.fn();
    render(
      <MemoryRouter>
        <ul>
          <ScheduleRow
            task={task}
            projectName="Demo"
            onOpen={() => undefined}
            onOpenInSplit={onOpenInSplit}
            onDuplicate={() => undefined}
            onAskDelete={() => undefined}
          />
        </ul>
      </MemoryRouter>
    );
    fireEvent.contextMenu(screen.getByTitle('Open schedule'));
    fireEvent.click(screen.getByRole('menuitem', { name: /Open in split/ }));
    expect(onOpenInSplit).toHaveBeenCalledTimes(1);
  });
});
