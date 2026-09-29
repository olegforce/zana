import { expect, it, vi } from 'vitest';
import { createSnapshotNotifications } from './snapshot-notifications.js';
import type { LibraryDoc } from '@zana-ai/zcc-domain/product';

const docs = [{ id: 'foreign-owner' }] as LibraryDoc[];
it('coalesces native/runtime changes and delivers another authoritative snapshot after an in-flight change', async () => {
  let finish!: (docs: LibraryDoc[]) => void;
  const read = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(docs), publish = vi.fn();
  const notifications = createSnapshotNotifications(read, publish);
  const first = notifications.invalidate(); await notifications.invalidate(); await notifications.invalidate();
  expect(read).toHaveBeenCalledOnce(); finish([]); await first;
  expect(read).toHaveBeenCalledTimes(2); expect(publish.mock.calls).toEqual([[[]], [docs]]);
  notifications.dispose();
});
it('preserves the previous snapshot on failure, retries on the next change and ignores late shutdown results', async () => {
  let finish!: (docs: LibraryDoc[]) => void;
  const read = vi.fn().mockRejectedValueOnce(new Error('owner offline')).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })), publish = vi.fn();
  const notifications = createSnapshotNotifications(read, publish);
  await notifications.invalidate(); expect(publish).not.toHaveBeenCalled();
  const waiting = notifications.invalidate(); await notifications.invalidate(); notifications.dispose(); finish(docs); await waiting;
  await notifications.invalidate(); expect(read).toHaveBeenCalledTimes(2); expect(publish).not.toHaveBeenCalled();
});
