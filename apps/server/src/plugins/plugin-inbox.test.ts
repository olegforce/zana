import { beforeEach, expect, it, vi } from 'vitest';
import { searchPluginInbox, readPluginInbox, INBOX_REPORT_MAX_CHARS } from './plugin-inbox.js';
import { readPluginProjectFile } from '../http/plugin-project-files.js';
vi.mock('../http/plugin-project-files.js', () => ({ readPluginProjectFile: vi.fn() }));
const entry = (id = 'one', extra = {}) => ({
  id,
  ts: 100,
  projectId: 'p1',
  subject: 'Slack review',
  report: true,
  comments: 'Useful findings',
  docs: [{ path: '.zcc/library/report.md' }],
  ...extra
});
let ctx: any;
beforeEach(() => {
  vi.clearAllMocks();
  ctx = {
    toProjects: () => [
      { id: 'p1', name: 'First' },
      { id: 'p2', name: 'Second' }
    ],
    inbox: { read: vi.fn(async () => ({ entries: [entry()], hasMore: false })) },
    inboxRead: { getReadState: vi.fn(async () => ({ readIds: {} })), markRead: vi.fn() }
  };
  vi.mocked(readPluginProjectFile).mockResolvedValue({
    content: '# Report',
    contentEncoding: 'utf8'
  } as any);
});
it('scopes searches, filters unread reports and text, and returns a usable cursor', async () => {
  ctx.inbox.read.mockResolvedValue({
    entries: [
      entry('foreign', { projectId: 'p2' }),
      entry('read'),
      entry('routine', { report: false, docs: [] }),
      entry('one'),
      entry('two')
    ],
    hasMore: true
  });
  ctx.inboxRead.getReadState.mockResolvedValue({ readIds: { read: true } });
  const result = await searchPluginInbox(ctx, {
    projectIds: ['p1'],
    unreadOnly: true,
    reportsOnly: true,
    query: 'SLACK',
    limit: 1,
    before: 'cursor'
  });
  expect(result).toMatchObject({
    entries: [{ id: 'one', unread: true, projectName: 'First', documents: 1 }],
    hasMore: true,
    nextBefore: 'one'
  });
  expect(ctx.inbox.read).toHaveBeenCalledWith({ limit: 500, before: 'cursor' });
  expect(ctx.inboxRead.markRead).not.toHaveBeenCalled();
});
it('continues paging after an empty matching scan and handles empty store', async () => {
  ctx.inbox.read
    .mockResolvedValueOnce({ entries: [entry()], hasMore: true })
    .mockResolvedValueOnce({ entries: [], hasMore: false });
  expect(await searchPluginInbox(ctx, { projectIds: ['p1'], query: 'missing' })).toEqual({
    entries: [],
    hasMore: true,
    nextBefore: 'one'
  });
  expect(await searchPluginInbox(ctx, { projectIds: ['p1'] })).toEqual({
    entries: [],
    hasMore: false
  });
});
it('recognizes docs-only reports and bounds projections', async () => {
  ctx.inbox.read.mockResolvedValue({
    entries: [
      entry('one', {
        subject: undefined,
        intent: 'Analysis',
        report: false,
        comments: 'x'.repeat(5000)
      }),
      entry('two', { subject: undefined, comments: undefined, docs: [] })
    ],
    hasMore: false
  });
  const result = await searchPluginInbox(ctx, {
    projectIds: ['p1'],
    query: 'report.md',
    reportsOnly: true
  });
  expect(result.entries[0]).toMatchObject({ subject: 'Analysis', comments: 'x'.repeat(4000) });
  expect((await searchPluginInbox(ctx, { projectIds: ['p1'] })).entries[1]).toMatchObject({
    subject: 'Report from Zana',
    documents: 0,
    comments: ''
  });
});
it.each([
  { projectIds: [] },
  { projectIds: ['unknown'] },
  { projectIds: ['p1'], limit: 26 },
  { projectIds: ['p1'], path: '/secret' }
])('rejects invalid search scope or fields %j', async (args) => {
  await expect(searchPluginInbox(ctx, args as any)).rejects.toThrow();
  expect(ctx.inbox.read).not.toHaveBeenCalled();
});
it('reads the stored document reference and reports truncation without mutating state', async () => {
  vi.mocked(readPluginProjectFile).mockResolvedValue({
    content: 'a'.repeat(INBOX_REPORT_MAX_CHARS + 1),
    contentEncoding: 'utf8'
  } as any);
  const result = await readPluginInbox(ctx, { projectIds: ['p1'], entryId: 'one' });
  expect(result.content).toHaveLength(INBOX_REPORT_MAX_CHARS);
  expect(result.truncated).toBe(true);
  expect(readPluginProjectFile).toHaveBeenCalledWith(ctx, {
    path: '.zcc/library/report.md',
    source: { kind: 'workspace', projectId: 'p1', environmentId: null, threadId: null }
  });
  expect(ctx.inboxRead.markRead).not.toHaveBeenCalled();
});
it('locates an older entry through bounded pages', async () => {
  ctx.inbox.read
    .mockResolvedValueOnce({ entries: [entry('new')], hasMore: true })
    .mockResolvedValueOnce({ entries: [entry()], hasMore: false });
  expect((await readPluginInbox(ctx, { projectIds: ['p1'], entryId: 'one' })).content).toBe(
    '# Report'
  );
  expect(ctx.inbox.read).toHaveBeenLastCalledWith({ limit: 500, before: 'new' });
});
it('reads comment-only reports, including empty content, with a cap', async () => {
  ctx.inbox.read
    .mockResolvedValueOnce({
      entries: [entry('one', { docs: [], comments: 'a'.repeat(20001) })],
      hasMore: false
    })
    .mockResolvedValueOnce({
      entries: [entry('one', { docs: [], comments: undefined })],
      hasMore: false
    });
  expect(await readPluginInbox(ctx, { projectIds: ['p1'], entryId: 'one' })).toMatchObject({
    truncated: true,
    content: 'a'.repeat(20000)
  });
  expect(await readPluginInbox(ctx, { projectIds: ['p1'], entryId: 'one' })).toMatchObject({
    truncated: false,
    content: ''
  });
});
it.each(['missing', 'foreign', 'index', 'binary', 'host-error'])(
  'rejects inaccessible report content: %s',
  async (mode) => {
    if (mode === 'missing') ctx.inbox.read.mockResolvedValue({ entries: [], hasMore: false });
    if (mode === 'foreign')
      ctx.inbox.read.mockResolvedValue({
        entries: [entry('one', { projectId: 'p2' })],
        hasMore: false
      });
    if (mode === 'binary')
      vi.mocked(readPluginProjectFile).mockResolvedValue({
        contentEncoding: 'base64',
        content: 'a'
      } as any);
    if (mode === 'host-error')
      vi.mocked(readPluginProjectFile).mockRejectedValue(new Error('Path escaped checkout'));
    await expect(
      readPluginInbox(ctx, {
        projectIds: ['p1'],
        entryId: 'one',
        ...(mode === 'index' ? { documentIndex: 2 } : {})
      })
    ).rejects.toThrow();
  }
);
it('stops scanning even if a broken store never finishes paging', async () => {
  ctx.inbox.read.mockResolvedValue({ entries: [entry('new')], hasMore: true });
  await expect(readPluginInbox(ctx, { projectIds: ['p1'], entryId: 'missing' })).rejects.toThrow(
    /unavailable/
  );
  expect(ctx.inbox.read).toHaveBeenCalledTimes(20);
});

it('accepts explicit scopes for large registered Project catalogues', async () => {
  const projectIds = Array.from({ length: 171 }, (_, i) => 'p' + i);
  ctx.toProjects = () => projectIds.map((id) => ({ id, name: id }));
  expect(await searchPluginInbox(ctx, { projectIds })).toMatchObject({
    entries: [{ id: 'one', projectId: 'p1' }]
  });
});
