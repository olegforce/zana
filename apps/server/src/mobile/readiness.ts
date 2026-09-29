export interface MobileReadySession {
  id: string;
  label: string;
  platform: 'ios' | 'android';
  appVersion: string;
  lastSeenAt: number;
}

/** Ephemeral evidence of an authenticated, mounted native shell. Never persisted. */
export class MobileReadiness {
  private readonly entries = new Map<string, MobileReadySession & { deviceId: string }>();
  constructor(private readonly now = Date.now) {}

  record(deviceId: string, label: string, input: Record<string, unknown>): boolean {
    if (typeof input.instanceId !== 'string' || !/^[a-f0-9]{32}$/.test(input.instanceId) ||
      !['ios', 'android'].includes(String(input.platform)) ||
      typeof input.appVersion !== 'string' || !/^\d+(\.\d+){0,2}$/.test(input.appVersion)) return false;
    this.prune();
    const id = `${deviceId}:${input.instanceId}`;
    if (!this.entries.has(id) && this.entries.size >= 40) return false;
    this.entries.set(id, { id, deviceId, label, platform: input.platform as 'ios' | 'android',
      appVersion: input.appVersion, lastSeenAt: this.now() });
    return true;
  }

  private prune() {
    for (const [id, entry] of this.entries)
      if (this.now() - entry.lastSeenAt >= 30_000) this.entries.delete(id);
  }

  list(isAuthorized: (deviceId: string) => boolean): MobileReadySession[] {
    this.prune();
    for (const [id, entry] of this.entries)
      if (!isAuthorized(entry.deviceId)) this.entries.delete(id);
    return [...this.entries.values()].map(({ deviceId: _, ...entry }) => entry);
  }
}
