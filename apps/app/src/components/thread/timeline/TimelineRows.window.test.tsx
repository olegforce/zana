// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ThreadTimelineViewRow } from '@zana-ai/zcc-thread-view';
import { TimelineRows } from './TimelineRows.js';
import { ThreadTimeline } from '../ThreadTimeline.js';
import { dispatchThreadMessageSent } from './thread-optimistic-events.js';
import { windowTimelineRows } from './timeline-window.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const rows = Array.from({ length: 5000 }, (_, index) => ({
  id: `row-${index}`, threadId: 't', turnId: 'turn', sourceSeqStart: index, sourceSeqEnd: index,
  startedAt: 1, createdAt: 1, kind: 'system', systemKind: 'info', title: `Message ${index}`, detail: null, status: 'completed'
}) as ThreadTimelineViewRow);
const expansion = { liveFrontierRowIds: new Set<string>(), terminalFrontierRowIds: new Set<string>() };

it('bounds loaded rows to 200 DOM rows and pages all the way to first and latest history', () => {
  const slot = render(<TimelineRows rows={rows} expansion={expansion} threadIdle />);
  const count = () => slot.container.querySelectorAll('[data-row-id]').length;
  expect(count()).toBe(200);
  expect(screen.getByText('Message 4999')).toBeTruthy();
  for (let page = 0; page < 24; page++) fireEvent.click(screen.getByTestId('timeline-earlier-page'));
  expect(screen.getByText('Message 0')).toBeTruthy(); expect(count()).toBe(200);
  expect(screen.queryByTestId('timeline-earlier-page')).toBeNull();
  for (let page = 0; page < 24; page++) fireEvent.click(screen.getByTestId('timeline-later-page'));
  expect(screen.getByText('Message 4999')).toBeTruthy(); expect(count()).toBe(200);
  expect(screen.queryByTestId('timeline-later-page')).toBeNull();
});
it('reveals an off-page search target and newly loaded older history without rendering the whole list', async () => {
  const slot = render(<TimelineRows rows={rows} expansion={expansion} targetRowId="row-9" historyPage={0} threadIdle />);
  expect(screen.getByText('Message 9')).toBeTruthy();
  expect(slot.container.querySelectorAll('[data-row-id]')).toHaveLength(200);
  slot.rerender(<TimelineRows rows={rows} expansion={expansion} targetRowId="row-4999" historyPage={0} threadIdle />);
  expect(screen.getByText('Message 4999')).toBeTruthy();
  await act(async () => slot.rerender(<TimelineRows rows={rows} expansion={expansion} historyPage={1} threadIdle />));
  expect(screen.getByText('Message 0')).toBeTruthy();
});
it('keeps anchored paging stable across prepends and keeps absent targets bounded', () => {
  expect(windowTimelineRows(rows,200,{ startId: 'row-400', keepId: 'absent' }).visible[0]!.id).toBe('row-400');
  expect(windowTimelineRows([{ ...rows[0]!, id: 'new' }, ...rows],200,{ startId: 'row-400' }).visible[0]!.id).toBe('row-400');
  expect(windowTimelineRows(rows,200,{ startId: 'absent', keepId: 'row-0' }).hiddenCount).toBe(0);
  expect(windowTimelineRows(rows.slice(0,10),200).visible).toHaveLength(10);
});

it('reserves a sticky user prompt across a large reply while retaining the latest and searched rows', () => {
  const user = { ...rows[0]!, id: 'prompt', kind: 'conversation', role: 'user', text: 'Long running request', attachments: null,
    initiator: 'user', senderThreadId: null, systemMessageKind: 'unlabeled', systemMessageSubject: null,
    turnRequest: { kind:'message', status:'accepted', isGrouped:false }, mentions: [] } as ThreadTimelineViewRow;
  const history = [user, ...rows];
  const slot = render(<TimelineRows rows={history} expansion={expansion} threadIdle />);
  expect(slot.container.querySelectorAll('[data-row-id]')).toHaveLength(200);
  expect(slot.container.querySelector('.thread-timeline-current-turn > .is-user')).toBeTruthy();
  expect(screen.getByText('Long running request')).toBeTruthy(); expect(screen.getByText('Message 4999')).toBeTruthy();
  slot.rerender(<TimelineRows rows={history} expansion={expansion} targetRowId="row-4800" threadIdle />);
  expect(screen.getByText('Message 4800')).toBeTruthy();
  expect(slot.container.querySelectorAll('[data-row-id]')).toHaveLength(200);
});

it('returns to the latest page on the scroll-to-bottom action and queued message sends', () => {
  let resized = () => {};
  vi.stubGlobal('ResizeObserver',class { constructor(callback: () => void) { resized=callback; } observe() {} disconnect() {} });
  render(<ThreadTimeline rows={rows as never} threadId="t" status="idle" thinking={null} />);
  const pane = screen.getByTestId('thread-timeline');
  Object.defineProperties(pane,{ clientHeight:{ get:() => 600 },scrollHeight:{ get:() => 2000 } });
  act(() => resized());
  fireEvent.click(screen.getByTestId('timeline-earlier-page'));
  expect(screen.queryByText('Message 4999')).toBeNull();
  pane.scrollTop=100; fireEvent.scroll(pane);
  fireEvent.click(screen.getByRole('button',{ name:'Scroll to bottom' }));
  expect(screen.getByText('Message 4999')).toBeTruthy();
  fireEvent.click(screen.getByTestId('timeline-earlier-page'));
  expect(screen.queryByText('Message 4999')).toBeNull();
  act(() => dispatchThreadMessageSent('t'));
  expect(screen.getByText('Message 4999')).toBeTruthy();
  expect(pane.querySelectorAll('[data-row-id]')).toHaveLength(200);
});

it('reveals newly loaded older history and guards the scroll anchor after unmount',async () => {
  let complete!:() => void;
  const load=vi.fn(() => new Promise<void>(resolve => {complete=resolve;}));
  vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback) => {callback(0);return 1;});
  const view=render(<ThreadTimeline rows={rows as never} threadId="t" status="idle" thinking={null} hasOlder onLoadOlder={load}/>);
  fireEvent.click(screen.getByTestId('thread-load-older'));
  await act(async () => complete());
  expect(screen.getByText('Message 0')).toBeTruthy();
  fireEvent.click(screen.getByTestId('thread-load-older'));view.unmount();
  await act(async () => complete());expect(load).toHaveBeenCalledTimes(2);
});
