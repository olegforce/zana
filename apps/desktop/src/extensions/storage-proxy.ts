import type { BrokerMethod } from './host-protocol.js';

/** Resolve only after the authenticated host has committed a storage write. */
export function createStorageProxy(broker: (method: BrokerMethod, args: unknown[]) => Promise<unknown>) {
  return {
    get: <T = unknown>(key: string) => broker('storage.get', [key]) as Promise<T | undefined>,
    set: async (key: string, value: unknown): Promise<void> => { await broker('storage.set', [key, value]); }
  };
}
