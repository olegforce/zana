import { afterEach, expect, it, vi } from 'vitest';
import { HostPreviewTunnel } from './preview-tunnel.js';
const h = vi.hoisted(() => ({ connect: vi.fn(), close: vi.fn(), options: null as any }));
vi.mock('../../../services/mobile-relay/client.mjs', () => ({ connectRelay: (options: unknown) => { h.options = options; h.connect(); return { state: () => 'connected', close: h.close }; } }));
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });
const input = (generation = 1, port = 23457) => ({ epoch: 'owner', generation, targets: [{ port, expiresAt: Date.now() + 60_000 }] });
it('requires Connect enrollment and an active owner connection', async () => {
  expect(await new HostPreviewTunnel('https://example.com').replace(input())).toMatchObject({ state: 'update-required' });
  const tunnel = new HostPreviewTunnel('https://example.com', 'credential'); expect(await tunnel.replace(input())).toMatchObject({ state: 'offline' }); tunnel.close();
});
it('rejects stale generations/protected ports, expires owner leases, and resets on reconnect', async () => {
  const tunnel = new HostPreviewTunnel('https://example.com', 'credential'); tunnel.setConnected(true);
  const result = await tunnel.replace(input()); expect(result.state).toBe('connected'); expect(h.options.previews()).toHaveLength(1);
  await expect(tunnel.replace(input())).rejects.toThrow('Stale');
  await expect(tunnel.replace({ ...input(2), epoch: 'forged' })).rejects.toThrow('owner');
  await expect(tunnel.replace(input(2, 8780))).rejects.toThrow('protected');
  const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 16_000); expect(h.options.previews()).toEqual([]);
  tunnel.setConnected(false); expect(h.close).toHaveBeenCalled(); expect(h.options.previews()).toEqual([]);
  tunnel.setConnected(true); await tunnel.replace({ epoch: 'new', generation: 1, targets: [] });
  tunnel.close();
});
