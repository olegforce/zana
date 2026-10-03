// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TimelineTitle } from '@zana-ai/zcc-thread-view';
import { TimelineTitleView } from './TimelineTitleView.js';

const title = (completedAt: number | null): TimelineTitle => ({
  tone: 'default', segments: [{ text: 'Work', em: false, shimmer: false, truncate: false }],
  decorations: [{ kind: 'duration', startedAt: 0, completedAt, em: false }], action: null
});

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('shares one timer between live duration labels without rerendering their parent list', () => {
  let listRenders = 0;
  function List() {
    listRenders++;
    return <><TimelineTitleView title={title(null)} /><TimelineTitleView title={title(null)} /></>;
  }
  const { unmount } = render(<List />);
  expect(vi.getTimerCount()).toBe(1);
  act(() => { vi.advanceTimersByTime(2000); });
  expect(screen.getAllByText('2s')).toHaveLength(2);
  expect(listRenders).toBe(1);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it('does not tick finished or idle work and releases the last subscription when work finishes', () => {
  const { rerender } = render(<TimelineTitleView title={title(null)} />);
  expect(vi.getTimerCount()).toBe(1);
  rerender(<TimelineTitleView title={title(5000)} />);
  expect(vi.getTimerCount()).toBe(0);
  expect(screen.getByText('5s')).toBeTruthy();
  rerender(<TimelineTitleView title={title(null)} live={false} />);
  expect(vi.getTimerCount()).toBe(0);
  act(() => { vi.advanceTimersByTime(10_000); });
  expect(screen.queryByText('10s')).toBeNull();
});

it('uses an explicitly supplied clock without registering a live timer', () => {
  render(<TimelineTitleView title={title(null)} now={3000} />);
  expect(screen.getByText('3s')).toBeTruthy();
  expect(vi.getTimerCount()).toBe(0);
});
