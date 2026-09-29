// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentState, TerminalSession } from '@zana-ai/zcc-domain/product';
import { AgentSessionHeader } from './AgentSessionHeader.js';
import { MOBILE_THREAD_CONTROLS_ID, MOBILE_THREAD_TITLE_ID } from './useMobileThreadTitleTarget.js';

const layout = vi.hoisted(() => ({ compact: true }));
vi.mock('../hooks/useCompactLayout.js', () => ({ useCompactLayout: () => layout.compact }));
afterEach(() => { cleanup(); layout.compact = true; });
const session = { title: 'Review mobile terminal', status: 'running' } as TerminalSession;
function Fixture({ enabled = true, state = 'working', title = session.title }: {
  enabled?: boolean; state?: AgentState; title?: string;
}) {
  return <>
    <div id={MOBILE_THREAD_TITLE_ID} data-testid="shell" />
    <div id={MOBILE_THREAD_CONTROLS_ID} data-testid="controls" />
    <AgentSessionHeader session={{ ...session, title }} state={state} projectName="Long project name" useShellTitle={enabled}>
      <button>Show right panel</button>
    </AgentSessionHeader>
  </>;
}

it('moves title, status and panel access into the shell and updates live state', () => {
  const { rerender, unmount } = render(<Fixture />);
  const shell = screen.getByTestId('shell');
  expect(within(shell).getByRole('heading').textContent).toBe(session.title);
  const header = document.querySelector('header')!;
  const controls = screen.getByTestId('controls');
  expect(within(controls).getByRole('button', { name: 'Show right panel' })).toBeTruthy();
  expect(within(header).queryByRole('button')).toBeNull();
  expect(header.getAttribute('data-controls-in-shell')).toBe('true');
  expect(header.getAttribute('data-title-in-shell')).toBe('true');
  expect(within(header).queryByRole('heading')).toBeNull();
  expect(screen.getByText('Working').getAttribute('data-status')).toBe('Working');
  expect(screen.getByRole('img', { name: 'Long project name · Working' })).toBeTruthy();
  rerender(<Fixture state="blocked" title="Renamed terminal" />);
  expect(within(shell).getByRole('heading').textContent).toBe('Renamed terminal');
  expect(screen.getByText('Needs you').getAttribute('data-status')).toBe('Needs you');
  unmount();
  expect(shell.childElementCount).toBe(0);
  expect(controls.childElementCount).toBe(0);
});

it('keeps embedded or inactive agent titles local and responds to viewport changes', () => {
  const { rerender } = render(<Fixture enabled={false} />);
  expect(screen.getByTestId('shell').childElementCount).toBe(0);
  expect(screen.queryByText('Working')).toBeNull();
  expect(screen.getByTestId('controls').childElementCount).toBe(0);
  expect(screen.getByRole('button').closest('header')).toBeTruthy();
  expect(screen.getByRole('heading').closest('header')).toBeTruthy();
  rerender(<Fixture />);
  expect(screen.getByText('Working')).toBeTruthy();
  layout.compact = false;
  rerender(<Fixture />);
  expect(screen.getByTestId('shell').childElementCount).toBe(0);
  expect(screen.queryByText('Working')).toBeNull();
  expect(screen.getByTestId('controls').childElementCount).toBe(0);
  expect(screen.getByRole('button').closest('header')).toBeTruthy();
  expect(screen.getByRole('heading').closest('header')).toBeTruthy();
});
