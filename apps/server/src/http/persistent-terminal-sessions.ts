import { z } from 'zod';
import type { ZccDatabase } from '@zana-ai/zcc-db';
import type { ProductTerminalRecord } from './product-context.js';
import { MAX_RETAINED_PRODUCT_TERMINALS } from './terminal-retention.js';
import { PRODUCT_TERMINAL_OUTPUT_MAX_BYTES } from './terminal-output-buffer.js';

// Adapted from BB's terminal-sessions durable ownership / daemonSessionId model.
// See docs/third-party/bb-shared-machines.md. Mutations must call set() after
// updating a record, so acknowledgement follows the SQLite commit.
const RecordSchema = z.object({
  id: z.string().min(1), projectId: z.string().min(1), hostId: z.string().min(1),
  daemonInstanceId: z.string().min(1).optional(),
  title: z.string(), profile: z.string(), cwd: z.string().min(1),
  status: z.enum(['starting', 'running', 'exited']), createdAt: z.number().finite(),
  outputText: z.string().optional(), outputTruncated: z.boolean().optional(),
  outputEndOffset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional()
}).passthrough();

/** A bounded cache over the product database; never the authority on restart. */
export class PersistentTerminalSessions extends Map<string, ProductTerminalRecord> {
  constructor(private readonly db: ZccDatabase) {
    super();
    const rows = db.sqlite.prepare('SELECT id, record_json FROM product_terminal_sessions LIMIT ?')
      .all(MAX_RETAINED_PRODUCT_TERMINALS + 1) as Array<{ id: string; record_json: string }>;
    if (rows.length > MAX_RETAINED_PRODUCT_TERMINALS) throw new Error('Terminal registry exceeds retention limit');
    for (const row of rows) {
      const record = this.validate(row.id, JSON.parse(row.record_json));
      super.set(row.id, record);
    }
  }

  private validate(id: string, value: unknown): ProductTerminalRecord {
    const parsed = RecordSchema.parse(value);
    if (id !== parsed.id) throw new Error('Terminal registry identity mismatch');
    if (Buffer.byteLength(parsed.outputText ?? '', 'utf8') > PRODUCT_TERMINAL_OUTPUT_MAX_BYTES) throw new Error('Terminal output exceeds retention limit');
    if (parsed.outputEndOffset !== undefined && parsed.outputEndOffset < (parsed.outputText?.length ?? 0)) throw new Error('Terminal output cursor precedes retained output');
    return parsed as ProductTerminalRecord;
  }

  override set(id: string, record: ProductTerminalRecord): this {
    this.validate(id, record);
    if (!this.has(id) && this.size >= MAX_RETAINED_PRODUCT_TERMINALS) throw new Error('Terminal registry exceeds retention limit');
    const json = JSON.stringify(record);
    // JSON may encode every retained control byte as six ASCII characters.
    if (Buffer.byteLength(json, 'utf8') > 2 * 1024 * 1024) throw new Error('Terminal record exceeds retention limit');
    this.db.sqlite.prepare('INSERT INTO product_terminal_sessions (id, record_json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record_json = excluded.record_json').run(id, json);
    return super.set(id, record);
  }

  override delete(id: string): boolean {
    this.db.sqlite.prepare('DELETE FROM product_terminal_sessions WHERE id = ?').run(id);
    return super.delete(id);
  }

  override clear(): void {
    this.db.sqlite.prepare('DELETE FROM product_terminal_sessions').run();
    super.clear();
  }
}
