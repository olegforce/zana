import { randomBytes, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { openConnectDatabase } from './database.mjs';
import { createRegistry } from './registry.mjs';

it.skipIf(!process.env.ZCC_CONNECT_TEST_DATABASE_URL)('serializes execution enrollment, recovery and revocation across real Postgres connections', async () => {
  const db = await openConnectDatabase(process.env.ZCC_CONNECT_TEST_DATABASE_URL, { production: true });
  const other = await openConnectDatabase(process.env.ZCC_CONNECT_TEST_DATABASE_URL, { production: true });
  const owner = randomUUID();
  try {
    await Promise.all([db.migrate(), other.migrate()]);
    const options = { domain: 'connect.example.com', accountUrl: 'https://example.com' };
    const a = createRegistry(db, options), b = createRegistry(other, options);
    const serverCode = await a.createComputerCode(owner);
    const registration = await a.redeemComputerCode(serverCode.code, 'Shared');
    const server = await a.authenticateServer(registration.credential);
    const input = { instanceId: randomUUID(), hostId: randomUUID(), name: 'Machine', enrollToken: `zcde_${randomBytes(18).toString('base64url')}` };
    const issued = await a.createMachineCode(server, input);
    const proofs = [randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url')];
    const attempts = await Promise.allSettled([a.redeemMachineCode(issued.code, proofs[0]), b.redeemMachineCode(issued.code, proofs[1])]);
    expect(attempts.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    const index = attempts.findIndex(row => row.status === 'fulfilled');
    const first = (attempts[index] as PromiseFulfilledResult<any>).value;
    expect(await b.redeemMachineCode(issued.code, proofs[index])).toEqual(first);
    expect(await b.authenticateMachine(server, first.credential)).toMatchObject({ host_id: input.hostId });
    expect(await a.listServers(owner)).toHaveLength(1);
    expect(await b.listMachines(owner, server.id)).toHaveLength(1);
    const second = await b.createMachineCode(server, { ...input, hostId: randomUUID() });
    const races = await Promise.allSettled([
      a.redeemMachineCode(second.code, randomBytes(32).toString('base64url')),
      b.revokeMachine(server, second.hostId)
    ]);
    expect(races[1].status).toBe('fulfilled');
    if (races[0].status === 'fulfilled') expect(await a.authenticateMachine(server, races[0].value.credential)).toBeNull();
    await b.revokeMachine(server, input.hostId);
    expect(await a.authenticateMachine(server, first.credential)).toBeNull();
    await expect(a.redeemMachineCode(issued.code, proofs[index])).rejects.toMatchObject({ status: 409 });
  } finally {
    await db.query('DELETE FROM connect_codes WHERE user_id=$1', [owner]);
    await db.query('DELETE FROM connect_servers WHERE user_id=$1', [owner]);
    await Promise.all([db.close(), other.close()]);
  }
});
