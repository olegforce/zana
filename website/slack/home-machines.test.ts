import { expect, it, vi } from 'vitest';
import { addHomeMachines, createHomeMachines } from './home-machines.mjs';

const link = { user_id: 'alice', server_id: 'linked' };
function fixture(servers: any[]) {
  const connect = { accountUrl: 'https://zana-ide.com', browserDomain: 'zana-ide.com', listServers: vi.fn().mockResolvedValue(servers) };
  return { connect, blocks: createHomeMachines({ connect, now: () => Date.UTC(2026, 9, 3, 20, 50, 8) }) };
}
it('shows the account inventory, online status, reserved addresses and the linked computer without exposing private fields', async () => {
  const f = fixture([
    { id: 'other', name: 'Build computer', live: true, paired: true, address: 'build', credential_hash: 'SECRET', hostId: 'PRIVATE' },
    { id: 'linked', name: 'My\nMac', live: false, paired: true },
    { id: 'pending', name: 'New machine', live: false, paired: false },
    { id: 'deleted', name: 'REVOKED', revoked: true, live: true },
  ]);
  const blocks = await f.blocks(link), text = JSON.stringify(blocks);
  expect(f.connect.listServers).toHaveBeenCalledWith('alice');
  expect(blocks[2].text.text).toBe('My Mac · ⚪ Offline · Linked to Slack\n\nBuild computer · 🟢 Online\nbuild.zana-ide.com\n\nNew machine · ⚪ Not connected yet');
  expect(blocks[2].accessory.url).toBe('https://zana-ide.com/connect/');
  expect(text).toContain('1 online · 3 registered');
  expect(text).toContain('20:50:08 UTC');
  for (const hidden of ['REVOKED', 'SECRET', 'PRIVATE', 'user_id', 'server_id']) expect(text).not.toContain(hidden);
});
it('bounds large inventories and names while prioritizing linked and online machines', async () => {
  const f = fixture(Array.from({ length: 500 }, (_, i) => ({ id: i === 499 ? 'linked' : `${i}`, name: 'x'.repeat(100) + i, live: i === 400 })));
  const blocks = await f.blocks(link), text = blocks[2].text.text;
  expect(text.split('\n\n')).toHaveLength(8);
  expect(text.split('\n\n')[0]).toContain('Linked to Slack');
  expect(text.split('\n\n')[1]).toContain('Online');
  expect(text.length).toBeLessThan(2000);
  expect(JSON.stringify(blocks)).toContain('Showing 8; see all in Manage machines');
});
it('handles an empty account and unavailable inventory without claiming machines are offline', async () => {
  const f = fixture([]);
  expect(JSON.stringify(await f.blocks(link))).toContain('No machines connected yet');
  f.connect.listServers.mockRejectedValueOnce(new Error('private failure'));
  const blocks = await f.blocks(link);
  expect(blocks).toHaveLength(3);
  expect(JSON.stringify(blocks)).toContain('Machine status is unavailable');
  expect(JSON.stringify(blocks)).not.toMatch(/Offline|private failure/);
  expect(JSON.stringify(await createHomeMachines({ connect: f.connect })(link))).toContain('checked');
});
it('inserts before Projects, preserves view metadata and never drops controls to exceed Slack’s block limit', async () => {
  const f = fixture([]), header = { type: 'header', text: { type: 'plain_text', text: 'Your agents' } };
  const projects = { type: 'divider' };
  const view = { type: 'home', callback_id: 'zana_home_v1', private_metadata: 'private-token', blocks: [header, projects] };
  const result = await addHomeMachines(view, link, f.blocks);
  expect(result).toMatchObject({ callback_id: view.callback_id, private_metadata: view.private_metadata });
  expect(result.blocks[0]).toEqual(header);
  expect(result.blocks[2].text.text).toBe('Machines');
  expect(result.blocks.at(-1)).toEqual(projects);
  expect(view.blocks).toHaveLength(2);
  const full = { ...view, blocks: Array.from({ length: 99 }, () => header) };
  expect((await addHomeMachines(full, link, f.blocks)).blocks).toHaveLength(100);
  full.blocks.push(header);
  expect(await addHomeMachines(full, link, f.blocks)).toBe(full);
  expect((await addHomeMachines({ type: 'home' }, link, f.blocks)).blocks).toHaveLength(4);
});
