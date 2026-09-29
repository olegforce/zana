import { beforeEach, expect, it, vi } from 'vitest';
import type { InboxEntry } from '@zana-ai/zcc-domain/product';

const api = vi.hoisted(() => ({ get: vi.fn(), unarchive: vi.fn(), send: vi.fn() }));
vi.mock('./product-client.js', () => ({ product: { threads: api } }));
import { reopenInboxThread, resolveInboxThread, sendInboxThreadReply } from './inbox-thread.js';

const entry: InboxEntry = { id: 'report', ts: 1, projectId: 'p', sessionId: 'thread' };
beforeEach(() => {
  vi.resetAllMocks();
  api.get.mockResolvedValue({ thread: { id: 'thread', projectId: 'p', title: 'Original work', archivedAt: null } });
  api.unarchive.mockResolvedValue({});
  api.send.mockResolvedValue({ ok: true });
});

it('resolves existing reports that only carry a sessionId', async () => {
  expect(await resolveInboxThread(entry)).toEqual({ id: 'thread', title: 'Original work', archived: false });
  expect(api.get).toHaveBeenCalledWith('thread');
});

it('prefers explicit thread provenance and tolerates untitled conversations', async () => {
  api.get.mockResolvedValue({ thread: { id: 'thread', projectId: 'p', title: ' ', archivedAt: 123 } });
  expect(await resolveInboxThread({ ...entry, sessionId: 'old', origin: { threadId: 'thread' } }))
    .toEqual({ id: 'thread', title: 'Untitled agent', archived: true });
  expect(api.get).toHaveBeenCalledWith('thread');
});

it('allows CLI fallback only for absent ids or confirmed missing legacy sessions', async () => {
  expect(await resolveInboxThread({ projectId: 'p' })).toBeNull();
  expect(api.get).not.toHaveBeenCalled();
  api.get.mockRejectedValue(Object.assign(new Error('missing'), { status: 404 }));
  expect(await resolveInboxThread(entry)).toBeNull();
  await expect(resolveInboxThread({ ...entry, origin: { threadId: 'thread' } })).rejects.toThrow('missing');
  await expect(reopenInboxThread(entry)).rejects.toThrow('no longer available');
});

it('keeps network errors from launching a replacement agent', async () => {
  api.get.mockRejectedValue(new Error('offline'));
  await expect(resolveInboxThread(entry)).rejects.toThrow('offline');
  await expect(sendInboxThreadReply(entry, 'Continue')).rejects.toThrow('offline');
  expect(api.send).not.toHaveBeenCalled();
});

it.each([{ id: 'other', projectId: 'p' }, { id: 'thread', projectId: 'other' }])(
  'rejects mismatched conversation identity %j', async (thread) => {
    api.get.mockResolvedValue({ thread });
    await expect(sendInboxThreadReply(entry, 'Continue')).rejects.toThrow('does not belong');
    expect(api.unarchive).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
  }
);

it('opens active threads without sending a prompt or creating a session', async () => {
  expect(await reopenInboxThread(entry)).toMatchObject({ id: 'thread', archived: false });
  expect(api.unarchive).not.toHaveBeenCalled();
  expect(api.send).not.toHaveBeenCalled();
});

it('restores an archived thread before sending into the same conversation', async () => {
  api.get.mockResolvedValue({ thread: { id: 'thread', projectId: 'p', archivedAt: 1 } });
  await sendInboxThreadReply(entry, '  Continue here  ');
  expect(api.unarchive).toHaveBeenCalledWith('thread');
  expect(api.send).toHaveBeenCalledWith('thread', 'Continue here', 'queue-if-active');
  expect(api.unarchive.mock.invocationCallOrder[0]).toBeLessThan(api.send.mock.invocationCallOrder[0]!);
});

it('does not send after restore fails', async () => {
  api.get.mockResolvedValue({ thread: { id: 'thread', projectId: 'p', archivedAt: 1 } });
  api.unarchive.mockRejectedValue(new Error('Host offline'));
  await expect(sendInboxThreadReply(entry, 'Continue')).rejects.toThrow('Host offline');
  expect(api.send).not.toHaveBeenCalled();
});

it('rejects empty and undelivered replies', async () => {
  await expect(sendInboxThreadReply(entry, ' ')).rejects.toThrow('Enter a reply');
  expect(api.get).not.toHaveBeenCalled();
  api.send.mockResolvedValue({ ok: false });
  await expect(sendInboxThreadReply(entry, 'Continue')).rejects.toThrow('Could not send');
});
