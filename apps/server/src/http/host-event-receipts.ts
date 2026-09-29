import { createHash } from 'node:crypto';
import type { ZccDatabase } from '@zana-ai/zcc-db';
import { HostEventAckMessageSchema, type HostEventAckMessage, type HostEventBatchMessage } from '@zana-ai/zcc-contracts/host-rpc';

export function hostEventDigest(batch: HostEventBatchMessage): string {
  return createHash('sha256').update(JSON.stringify(batch.events)).digest('hex');
}

/** One acknowledged batch per host: daemons serialize delivery and retries. */
export function readHostEventReceipt(db: ZccDatabase, batch: HostEventBatchMessage): HostEventAckMessage | null {
  if (!batch.batchId) return null;
  const row = db.sqlite.prepare('SELECT digest, ack_json FROM host_event_receipts WHERE host_id = ? AND instance_id = ? AND batch_id = ?')
    .get(batch.hostId, batch.instanceId, batch.batchId) as { digest: string; ack_json: string } | undefined;
  if (!row) return null;
  if (row.digest !== hostEventDigest(batch)) throw new Error('Host event batch identity was reused with different events');
  return HostEventAckMessageSchema.parse(JSON.parse(row.ack_json));
}

/** Call inside the SAME transaction that applies events, before sending ack. */
export function writeHostEventReceipt(db: ZccDatabase, batch: HostEventBatchMessage, ack: HostEventAckMessage): void {
  if (!batch.batchId) return;
  db.sqlite.prepare(`INSERT INTO host_event_receipts (host_id, instance_id, batch_id, digest, ack_json) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(host_id) DO UPDATE SET instance_id = excluded.instance_id, batch_id = excluded.batch_id, digest = excluded.digest, ack_json = excluded.ack_json`)
    .run(batch.hostId, batch.instanceId, batch.batchId, hostEventDigest(batch), JSON.stringify(ack));
}
