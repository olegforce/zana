// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TurnArchiveRow } from './TurnArchiveRow.js';

const api = vi.hoisted(() => ({ details: vi.fn() }));
vi.mock('../../../lib/product-client.js', () => ({ product: { threads: { timelineTurnSummaryDetails: api.details } } }));
vi.mock('./TimelineRows.js', () => ({ TimelineRows: ({ rows }: any) => <div>{rows.map((row: any) => <p key={row.id}>{row.text}</p>)}</div> }));
vi.mock('./TimelineTitleView.js', () => ({ TimelineTitleView: () => <span>Worked</span> }));
const message = (id: string, seq: number) => ({ id, kind: 'conversation', role: 'assistant', text: id,
  threadId: 't', turnId: 'turn', sourceSeqStart: seq, sourceSeqEnd: seq, createdAt: seq, startedAt: seq,
  attachments: null, turnRequest: null });
const props: any = { row: { id: 'turn', kind: 'turn', turnId: 'turn', status: 'completed', children: null,
  sourceSeqStart: 1, sourceSeqEnd: 10 }, title: {}, now: 1, expansion: {}, threadId: 't' };
beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);

it('loads only expanded turns and merges earlier details without duplicating nested identities', async () => {
  api.details.mockResolvedValueOnce({ rows: [message('later', 2)], olderCursor: 'older' })
    .mockResolvedValueOnce({ rows: [message('earlier', 1), message('later', 2)], olderCursor: null });
  render(<TurnArchiveRow {...props} />);
  expect(api.details).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Worked' }));
  await screen.findByText('later');
  fireEvent.click(screen.getByRole('button', { name: 'Load earlier details' }));
  await screen.findByText('earlier');
  expect(screen.getAllByText('later')).toHaveLength(1);
  expect(api.details).toHaveBeenLastCalledWith('t', expect.objectContaining({ beforeCursor: 'older' }));
  expect(screen.queryByText('Load earlier details')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Worked' }));
  fireEvent.click(screen.getByRole('button', { name: 'Worked' }));
  expect(api.details).toHaveBeenCalledTimes(2);
});

it('shows a retry after failure and loads a force-expanded summary', async () => {
  api.details.mockRejectedValueOnce(new Error('failed')).mockResolvedValueOnce({ rows: [message('recovered', 1)] });
  render(<TurnArchiveRow {...props} forceExpandedRowIds={new Set(['turn'])} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Could not load details. Retry' }));
  await screen.findByText('recovered');
});

it('discards an old thread response after navigation', async () => {
  let resolve!: (value: unknown) => void;
  api.details.mockImplementationOnce(() => new Promise(r => { resolve = r; })).mockResolvedValueOnce({ rows: [message('new thread', 1)] });
  const { rerender } = render(<TurnArchiveRow {...props} forceExpandedRowIds={new Set(['turn'])} />);
  await waitFor(() => expect(api.details).toHaveBeenCalledTimes(1));
  rerender(<TurnArchiveRow {...props} threadId="other" forceExpandedRowIds={new Set(['turn'])} />);
  await screen.findByText('new thread');
  resolve({ rows: [message('stale thread', 1)] });
  await Promise.resolve();
  expect(screen.queryByText('stale thread')).toBeNull();
});
