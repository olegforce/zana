import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { openDatabase, upsertHost } from '@zana-ai/zcc-db';
import { MobileConnectionStore } from '../../mobile/connection.js';
import { createJoinCodeStore } from './join-codes.js';
import { issueConnectHostCode, revokeConnectHost, connectInstallCommand, usesConnect } from './connect-enrollment.js';
import type { ProductHttpContext } from '../../http/product-context.js';
it('binds enrollment to this instance, cleans failures, and preserves a repaired host identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'connect-enrollment-')), db = openDatabase(join(dir, 'state.sqlite'));
  try {
    const ctx = { dataDir: dir, db, productInstanceId: randomUUID(), joinCodes: createJoinCodeStore(db) } as ProductHttpContext;
    const store = new MobileConnectionStore(join(dir, 'mobile', 'connection.json'));
    expect(usesConnect(ctx)).toBe(false);
    await expect(issueConnectHostCode(ctx, { name: 'Laptop' })).rejects.toThrow('Connect this');
    const serverId = randomUUID(), accountUrl = 'https://zana-ide.com', publicUrl = 'https://fixture.zana-ide.com';
    await store.write({ mode: 'connect', accountUrl, serverId, publicUrl, relayToken: 'a'.repeat(43) });
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.instanceId).toBe(ctx.productInstanceId);
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ' + 'a'.repeat(43));
      return Response.json({ code: 'ABCD-ABCD-ABCD-ABCD-ABCD-ABCD-ABCD-ABCD', serverId, hostId: body.hostId, serverUrl: publicUrl, expiresAt: Date.now() + 60_000 });
    }) as unknown as typeof fetch;
    const issued = await issueConnectHostCode(ctx, { name: 'Laptop' }, fetcher);
    expect(ctx.joinCodes.status(issued.enrollmentId)?.hostId).toBe(issued.hostId);
    const primary = upsertHost(db, { name: 'Primary', hostKeyHash: 'a'.repeat(64) });
    upsertHost(db, { id: issued.hostId, name: 'Laptop', hostKeyHash: 'b'.repeat(64), isPrimary: false });
    const repaired = await issueConnectHostCode(ctx, { name: 'Laptop', hostId: issued.hostId }, fetcher);
    expect(repaired.hostId).toBe(issued.hostId);
    expect(ctx.joinCodes.status(issued.enrollmentId)).toBeNull();
    for (const input of [null, [], {}, { name: 'bad\nname' }, { name: 'Laptop', hostId: primary.id }, { name: 'Laptop', hostId: randomUUID() }, { name: 'Laptop', extra: true }]) await expect(issueConnectHostCode(ctx, input, fetcher)).rejects.toThrow();
    await expect(issueConnectHostCode(ctx, { name: 'Failed' }, (async () => Response.json({ serverId: 'wrong' })) as typeof fetch)).rejects.toThrow('Invalid');
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM host_join_codes').get()).toEqual({ n: 1 });
    const revoke = vi.fn(async () => Response.json({ ok: true })) as unknown as typeof fetch;
    await revokeConnectHost(ctx, issued.hostId, revoke);
    expect(revoke).toHaveBeenCalledWith(accountUrl + '/api/connect/hosts/revoke', expect.objectContaining({ body: JSON.stringify({ hostId: issued.hostId }) }));
    await expect(revokeConnectHost(ctx, issued.hostId, (async () => new Response('', { status: 503 })) as typeof fetch)).rejects.toThrow('503');
    expect(connectInstallCommand({ accountUrl, serverId, code: "quote'code" })).toContain("quote'\\''code");
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
