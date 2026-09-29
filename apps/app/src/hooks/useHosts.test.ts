import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Host } from '@zana-ai/zcc-domain/thread-runtime';
import { connectedHosts, defaultHostId, primaryHost } from './useHosts.js';

function host(patch: Partial<Host> & Pick<Host, 'id' | 'name'>): Host {
  return {
    type: 'persistent',
    status: 'connected',
    maxPermissionMode: 'full',
    lastSeenAt: 1,
    lastRejectedProtocolVersion: null,
    isPrimary: false,
    canRepairViaSsh: false,
    createdAt: 1,
    updatedAt: 1,
    ...patch
  };
}

const primary = host({ id: 'h-primary', name: 'Laptop', isPrimary: true });
const remote = host({ id: 'h-remote', name: 'Devbox' });

describe('defaultHostId', () => {
  it('uses the bound daemon for SSH remotes and skips this machine', () => {
    expect(defaultHostId([primary, remote], { remote: { host: 'devbox' } })).toBeUndefined();
    expect(defaultHostId([primary, remote], {
      remote: { host: 'devbox' },
      hostId: 'h-remote'
    })).toBe('h-remote');
  });

  it('keeps local projects on their bound host or the primary', () => {
    expect(defaultHostId([primary, remote])).toBe('h-primary');
    expect(defaultHostId([primary, remote], { hostId: 'h-remote' })).toBe('h-remote');
  });
  it('keeps a bound machine when its row is absent instead of silently selecting another machine', () => {
    for (const hosts of [[], [primary], [remote]]) {
      expect(defaultHostId(hosts, { hostId: 'missing-owner' })).toBe('missing-owner');
      expect(defaultHostId(hosts, { hostId: 'missing-owner', remote: {} })).toBe('missing-owner');
    }
    expect(defaultHostId([remote])).toBeUndefined();
    expect(primaryHost([remote])).toBeUndefined();
    expect(connectedHosts([primary, { ...remote, status: 'disconnected' }])).toEqual([primary]);
  });
});

describe('useHosts remount cache', () => {
  it('hydrates from the last fetched roster instead of an empty list', () => {
    const source = readFileSync(new URL('./useHosts.ts', import.meta.url), 'utf8');
    expect(source).toContain('let cachedHosts: Host[] = []');
    expect(source).toContain('useState<Host[]>(() => cachedHosts)');
    expect(source).toContain('resetHostsCache');
    expect(source).toContain('rememberHosts');
  });
});
