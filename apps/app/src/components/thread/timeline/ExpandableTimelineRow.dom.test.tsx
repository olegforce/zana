// @vitest-environment happy-dom
import { useEffect, useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExpandableTimelineRow } from './ExpandableTimelineRow.js';
import { useTimelineWorkRowFullOutput, type TimelinePreviewableWorkRow } from './useTimelineWorkRowFullOutput.js';

const api = vi.hoisted(() => ({ details: vi.fn(), mount: vi.fn(), unmount: vi.fn() }));
vi.mock('../../../lib/product-client.js', () => ({ product: { threads: { timelineTurnSummaryDetails: api.details } } }));

const row: TimelinePreviewableWorkRow = {
  id: 'tool', threadId: 'thread', turnId: 'turn', sourceSeqStart: 1, sourceSeqEnd: 5,
  startedAt: 1, createdAt: 1, kind: 'work', workKind: 'command', status: 'completed',
  callId: 'call', command: 'npm test', cwd: null, source: null, output: 'Preview',
  outputPreview: { totalChars: 20_000 }, exitCode: 0, completedAt: 5, approvalStatus: null, activityIntents: []
};
function Output() {
  const full = useTimelineWorkRowFullOutput(row);
  const [draft, setDraft] = useState('');
  useEffect(() => { api.mount(); return () => { api.unmount(); }; }, []);
  return <><p>{full.output}</p><input aria-label="Detail state" value={draft} onChange={(e) => setDraft(e.target.value)} /></>;
}
beforeEach(() => {
  vi.clearAllMocks();
  api.details.mockResolvedValue({ rows: [{ id: 'tool', output: 'Full output' }] });
});
afterEach(cleanup);

it('does not mount or fetch closed output, then loads it only once and preserves state on collapse', async () => {
  const { unmount } = render(<ExpandableTimelineRow summary="Run tests"><Output /></ExpandableTimelineRow>);
  expect(api.mount).not.toHaveBeenCalled();
  expect(api.details).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Run tests' }));
  await screen.findByText('Full output');
  expect(api.details).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Remember me' } });
  fireEvent.click(screen.getByRole('button', { name: 'Run tests' }));
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(api.unmount).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Run tests' }));
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Remember me');
  expect(api.details).toHaveBeenCalledTimes(1);
  unmount();
  expect(api.unmount).toHaveBeenCalledTimes(1);
});

it.each(['autoExpanded', 'terminalAutoExpanded', 'forceExpanded'] as const)('mounts details when %s becomes true', async (flag) => {
  const { rerender } = render(<ExpandableTimelineRow summary="Run tests"><Output /></ExpandableTimelineRow>);
  expect(api.details).not.toHaveBeenCalled();
  rerender(<ExpandableTimelineRow summary="Run tests" {...{ [flag]: true }}><Output /></ExpandableTimelineRow>);
  await screen.findByText('Full output');
  expect(screen.getByRole('button', { name: 'Run tests' }).getAttribute('aria-expanded')).toBe('true');
});

it('honors controlled expansion and leaves non-expandable details unmounted', async () => {
  const onToggle = vi.fn();
  const { rerender } = render(<ExpandableTimelineRow summary="Run tests" open={false} onToggle={onToggle}><Output /></ExpandableTimelineRow>);
  fireEvent.click(screen.getByRole('button', { name: 'Run tests' }));
  expect(onToggle).toHaveBeenCalledWith(true);
  expect(api.details).not.toHaveBeenCalled();
  rerender(<ExpandableTimelineRow summary="Run tests" open onToggle={onToggle}><Output /></ExpandableTimelineRow>);
  await waitFor(() => expect(api.details).toHaveBeenCalledTimes(1));
  rerender(<ExpandableTimelineRow summary="Run tests" expandable={false}><Output /></ExpandableTimelineRow>);
  expect(screen.queryByRole('button')).toBeNull();
  expect(api.unmount).toHaveBeenCalledTimes(1);
});
