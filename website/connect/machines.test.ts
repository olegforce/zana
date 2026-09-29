import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openConnectDatabase } from './database.mjs';
import { createRegistry, CODE_TTL, digest } from './registry.mjs';

let db: any, registry: any, server: any, clock: number;
const secret = () => randomBytes(32).toString('base64url');
const enrollment = (overrides = {}) => ({ instanceId: randomUUID(), hostId: randomUUID(), name: 'Work laptop', enrollToken: `zcde_${randomBytes(18).toString('base64url')}`, ...overrides });
async function addServer(owner = 'alice') {
  const { code } = await registry.createComputerCode(owner);
  return registry.authenticateServer((await registry.redeemComputerCode(code, 'Shared Zana')).credential);
}
beforeEach(async () => {
  clock = 1_800_000_000_000;
  db = await openConnectDatabase(':memory:', { production: false }); await db.migrate();
  registry = createRegistry(db, { domain: 'connect.example.com', accountUrl: 'https://example.com', now: () => clock });
  server = await addServer();
});
afterEach(() => db.close());

it('pairs two execution hosts into one server and keeps phone credentials separate', async () => {
  const instanceId = randomUUID();
  const hosts = [];
  for (let i = 0; i < 2; i++) {
    const input = enrollment({ instanceId });
    const issued = await registry.createMachineCode(server, input);
    const joined = await registry.redeemMachineCode(issued.code, secret());
    expect(joined).toMatchObject({ instanceId, hostId: input.hostId, serverId: server.id, enrollToken: input.enrollToken, expiresAt: clock + CODE_TTL });
    expect(await registry.authenticateMachine(server, joined.credential)).toMatchObject({ host_id: input.hostId });
    expect(await registry.authenticateDevice(joined.credential)).toBeNull();
    expect(await registry.authenticateServer(joined.credential)).toBeNull();
    hosts.push(joined);
  }
  expect(hosts[0].machineId).not.toBe(hosts[1].machineId);
  expect(await registry.listServers('alice')).toHaveLength(1);
  expect(await registry.listMachines('alice', server.id)).toHaveLength(2);
  expect(await registry.listMachines('bob', server.id)).toEqual([]);
  const phone = await registry.redeemPhoneCode(server, (await registry.createPhoneCode(server)).code, 'Phone');
  expect(await registry.authenticateMachine(server, phone.credential)).toBeNull();
  const rows = await db.query('SELECT * FROM connect_machine_codes');
  for (const h of hosts) {
    expect(JSON.stringify(rows)).not.toContain(h.enrollToken);
    expect(JSON.stringify(rows)).not.toContain(h.credential);
  }
  expect(JSON.stringify(await registry.listMachines('alice', server.id))).not.toContain('credential');
});

it('recovers an interrupted response only for the original private attempt', async () => {
  const issued = await registry.createMachineCode(server, enrollment());
  const attempt = secret();
  const results = await Promise.all([registry.redeemMachineCode(issued.code, attempt), registry.redeemMachineCode(issued.code, attempt)]);
  expect(results[0]).toEqual(results[1]);
  await expect(registry.redeemMachineCode(issued.code, secret())).rejects.toMatchObject({ status: 409 });
  expect(await registry.listMachines('alice', server.id)).toHaveLength(1);
  const [row] = await db.query('SELECT * FROM connect_machine_codes');
  expect(row.request_hash).toBe(digest(attempt));
  expect(JSON.stringify(row)).not.toContain(attempt);
});

it('allows exactly one of competing attempts to consume a code', async () => {
  const issued = await registry.createMachineCode(server, enrollment());
  const results = await Promise.allSettled([registry.redeemMachineCode(issued.code, secret()), registry.redeemMachineCode(issued.code, secret())]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
});

it('pins instance identity and rejects cross-instance or wrong-account machine use', async () => {
  const input = enrollment();
  expect(await registry.bindInstance(server, input.instanceId)).toEqual({ serverId: server.id, instanceId: input.instanceId });
  await expect(registry.bindInstance(server, randomUUID())).rejects.toMatchObject({ message: 'instance_mismatch', status: 409 });
  const joined = await registry.redeemMachineCode((await registry.createMachineCode(server, input)).code, secret());
  const sameAccountOtherInstance = await addServer();
  const otherAccount = await addServer('bob');
  expect(await registry.authenticateMachine(sameAccountOtherInstance, joined.credential)).toBeNull();
  expect(await registry.authenticateMachine(otherAccount, joined.credential)).toBeNull();
  expect(await registry.authenticateMachine({ ...server, user_id: 'bob' }, joined.credential)).toBeNull();
});

it('repairs only one host, replacing its old key without another host or server', async () => {
  const input = enrollment();
  const first = await registry.redeemMachineCode((await registry.createMachineCode(server, input)).code, secret());
  expect(await registry.revokeMachine(server, input.hostId)).toBe(first.machineId);
  expect(await registry.revokeMachine(server, input.hostId)).toBeNull();
  const second = await registry.redeemMachineCode((await registry.createMachineCode(server, { ...input, name: 'Renamed' })).code, secret());
  expect(second.machineId).toBe(first.machineId);
  expect(await registry.authenticateMachine(server, first.credential)).toBeNull();
  expect(await registry.authenticateMachine(server, second.credential)).toMatchObject({ name: 'Renamed' });
  expect(await registry.listMachines('alice', server.id)).toHaveLength(1);
});

it('revocation prevents both replay and pending enrollment while other hosts remain valid', async () => {
  const one = enrollment(), two = enrollment({ instanceId: one.instanceId });
  const code = await registry.createMachineCode(server, one), attempt = secret();
  const joined = await registry.redeemMachineCode(code.code, attempt);
  const other = await registry.redeemMachineCode((await registry.createMachineCode(server, two)).code, secret());
  await registry.revokeMachine(server, one.hostId);
  expect(await registry.authenticateMachine(server, joined.credential)).toBeNull();
  await expect(registry.redeemMachineCode(code.code, attempt)).rejects.toMatchObject({ status: 409 });
  expect(await registry.authenticateMachine(server, other.credential)).not.toBeNull();
  const pending = await registry.createMachineCode(server, one);
  await registry.revokeMachine(server, one.hostId);
  await expect(registry.redeemMachineCode(pending.code, secret())).rejects.toMatchObject({ status: 409 });
});

it('rechecks server revocation during issuance, redemption and authentication', async () => {
  const input = enrollment(), pending = await registry.createMachineCode(server, input);
  const joined = await registry.redeemMachineCode(pending.code, secret());
  await registry.revoke('alice', 'server', server.id);
  expect(await registry.authenticateMachine(server, joined.credential)).toBeNull();
  await expect(registry.createMachineCode(server, input)).rejects.toMatchObject({ status: 403 });
  await expect(registry.redeemMachineCode(pending.code, secret())).rejects.toMatchObject({ status: 409 });
  await expect(registry.revokeMachine(server, input.hostId)).rejects.toMatchObject({ status: 403 });
});

it('expires and prunes grants, without affecting the existing server', async () => {
  const issued = await registry.createMachineCode(server, enrollment());
  clock += CODE_TTL;
  await expect(registry.redeemMachineCode(issued.code, secret())).rejects.toMatchObject({ status: 409 });
  await registry.prune();
  expect(await db.query('SELECT * FROM connect_machine_codes')).toEqual([]);
  expect(await registry.listServers('alice')).toHaveLength(1);
});

it('validates boundary inputs without consuming codes or creating bindings', async () => {
  for (const patch of [{ instanceId: 'bad' }, { hostId: '../host' }, { name: '' }, { name: 'bad\nname' }, { name: 'x'.repeat(81) }, { enrollToken: 'secret' }]) {
    await expect(registry.createMachineCode(server, enrollment(patch))).rejects.toMatchObject({ status: 400 });
  }
  expect(await db.query('SELECT * FROM connect_instances')).toEqual([]);
  for (const code of [null, 123, '', 'x'.repeat(81), 'wrong']) await expect(registry.redeemMachineCode(code, secret())).rejects.toMatchObject({ status: 400 });
  const issued = await registry.createMachineCode(server, enrollment());
  await expect(registry.redeemMachineCode(issued.code, 'short')).rejects.toMatchObject({ status: 400 });
  expect(await registry.redeemMachineCode(` ${issued.code.toLowerCase()} `, secret())).toHaveProperty('credential');
  expect(await registry.authenticateMachine(server, 'bad')).toBeNull();
  await expect(registry.revokeMachine(server, 'invalid')).rejects.toMatchObject({ status: 400 });
});

it('enforces bounded pending/active grants and rolls back failed issuance', async () => {
  const limited = createRegistry(db, { domain: 'connect.example.com', accountUrl: 'https://example.com', now: () => clock, limit: 1 });
  const input = enrollment(), issued = await limited.createMachineCode(server, input);
  await expect(limited.createMachineCode(server, enrollment({ instanceId: input.instanceId }))).rejects.toMatchObject({ status: 409 });
  await limited.redeemMachineCode(issued.code, secret());
  await expect(limited.createMachineCode(server, enrollment({ instanceId: input.instanceId }))).rejects.toMatchObject({ status: 409 });
  await db.migrate();
  expect(await limited.listMachines('alice', server.id)).toHaveLength(1);
});

it('rejects a retry after its grant was rotated and rejects corrupted enrollment storage', async () => {
  const input = enrollment(), issued = await registry.createMachineCode(server, input), attempt = secret();
  const joined = await registry.redeemMachineCode(issued.code, attempt);
  await db.query('UPDATE connect_machines SET credential_hash=$1 WHERE id=$2', [digest(secret()), joined.machineId]);
  await expect(registry.redeemMachineCode(issued.code, attempt)).rejects.toMatchObject({ status: 403 });
  const next = await registry.createMachineCode(server, input);
  await db.query('UPDATE connect_machine_codes SET enrollment=$1 WHERE hash=$2', ['corrupt', digest(next.code.replaceAll('-', ''))]);
  await expect(registry.redeemMachineCode(next.code, secret())).rejects.toThrow();
  const [row] = await db.query('SELECT consumed_at FROM connect_machine_codes');
  expect(row.consumed_at).toBeNull();
});

it('permits repair and replacement of a pending code at the account limit', async () => {
  const limited = createRegistry(db, { domain: 'connect.example.com', accountUrl: 'https://example.com', now: () => clock, limit: 1 });
  const input = enrollment();
  const stale = await limited.createMachineCode(server, input);
  const current = await limited.createMachineCode(server, input);
  await expect(limited.redeemMachineCode(stale.code, secret())).rejects.toThrow();
  const first = await limited.redeemMachineCode(current.code, secret());
  const repair = await limited.createMachineCode(server, input);
  const next = await limited.redeemMachineCode(repair.code, secret());
  expect(next.machineId).toBe(first.machineId);
  expect(await limited.authenticateMachine(server, first.credential)).toBeNull();
});

it.each([4, 8, 12, 13, 14, 15])('rejects a valid shortened %i-byte GCM tag without consuming the enrollment', async authTagLength => {
  const input = enrollment(), issued = await registry.createMachineCode(server, input), attempt = secret();
  const raw = issued.code.replaceAll('-', ''), hash = digest(raw);
  const [original] = await db.query('SELECT enrollment FROM connect_machine_codes WHERE hash=$1', [hash]);
  const key = createHash('sha256').update(`zana-host-enrollment:${raw}`).digest();
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength });
  cipher.setAAD(Buffer.from(`${server.id}:${input.hostId}`));
  // An empty ciphertext leaves only the shorter, cryptographically valid tag
  // after the IV. Decryption must require the format's full 16-byte tag.
  const data = cipher.final();
  const shortened = Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
  await db.query('UPDATE connect_machine_codes SET enrollment=$1 WHERE hash=$2', [shortened, hash]);
  await expect(registry.redeemMachineCode(issued.code, attempt)).rejects.toThrow('Invalid authentication tag length');
  expect(await registry.listMachines('alice', server.id)).toEqual([]);
  expect((await db.query('SELECT consumed_at FROM connect_machine_codes WHERE hash=$1', [hash]))[0].consumed_at).toBeNull();
  await db.query('UPDATE connect_machine_codes SET enrollment=$1 WHERE hash=$2', [original.enrollment, hash]);
  expect(await registry.redeemMachineCode(issued.code, attempt)).toMatchObject({ enrollToken: input.enrollToken });
});
