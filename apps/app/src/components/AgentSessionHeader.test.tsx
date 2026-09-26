// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentState, TerminalSession } from '@zana-ai/zcc-domain/product';
import { AgentSessionHeader } from './AgentSessionHeader.js';
import { MOBILE_THREAD_TITLE_ID } from './useMobileThreadTitleTarget.js';

const layout = vi.hoisted(() => ({ compact: true }));
vi.mock('../hooks/useCompactLayout.js', () => ({ useCompactLayout: () => layout.compact }));
afterEach(() => { cleanup(); layout.compact = true; });
const session = { title: 'Review mobile terminal', status: 'running' } as TerminalSession;
function Fixture({ enabled = true, state = 'working', title = session.title }: {
  enabled?: boolean; state?: AgentState; title?: string;
}) {
  return <>
    <div id={MOBILE_THREAD_TITLE_ID} data-testid="shell" />
    <AgentSessionHeader session={{ ...session, title }} state={state} projectName="Long project name" useShellTitle={enabled}>
      <button>Show right panel</button>
    </AgentSessionHeader>
  </>;
}

it('shares the shell title while keeping status, project and panel access in one agent row', () => {
  const { rerender, unmount } = render(<Fixture />);
  const shell = screen.getByTestId('shell');
  expect(within(shell).getByRole('heading').textContent).toBe(session.title);
  const header = screen.getByText('Show right panel').closest('header')!;
  expect(header.getAttribute('data-title-in-shell')).toBe('true');
  expect(within(header).queryByRole('heading')).toBeNull();
  expect(screen.getByText('Working').getAttribute('data-status')).toBe('Working');
  expect(screen.getByTitle('Long project name')).toBeTruthy();
  rerender(<Fixture state="blocked" title="Renamed terminal" />);
  expect(within(shell).getByRole('heading').textContent).toBe('Renamed terminal');
  expect(screen.getByText('Needs you').getAttribute('data-status')).toBe('Needs you');
  unmount();
  expect(shell.childElementCount).toBe(0);
});

it('keeps embedded or inactive agent titles local and responds to viewport changes', () => {
  const { rerender } = render(<Fixture enabled={false} />);
  expect(screen.getByTestId('shell').childElementCount).toBe(0);
  expect(screen.queryByText('Working')).toBeNull();
  expect(screen.getByRole('heading').closest('header')).toBeTruthy();
  rerender(<Fixture />);
  expect(screen.getByText('Working')).toBeTruthy();
  layout.compact = false;
  rerender(<Fixture />);
  expect(screen.getByTestId('shell').childElementCount).toBe(0);
  expect(screen.queryByText('Working')).toBeNull();
  expect(screen.getByRole('heading').closest('header')).toBeTruthy();
});
