import { useEffect, useState } from 'react';
import type { Host } from '@zana-ai/zcc-domain/thread-runtime';
import { updateModelCatalogHosts } from '../components/thread/pickers/thread-model-catalog.js';
import { subscribeProductReconnect } from '../lib/product-ws.js';
import { product } from '../lib/product-client.js';

/** Last roster from a successful (or empty) fetch — survives composer remounts. */
let cachedHosts: Host[] = [];

function rememberHosts(rows: Host[]): Host[] {
  updateModelCatalogHosts(rows);
  cachedHosts = rows;
  return rows;
}

/** Test hook: drop the remount cache so specs start from an empty roster. */
export function resetHostsCache(): void {
  cachedHosts = [];
}

export function useHosts(): Host[] {
  const [hosts, setHosts] = useState<Host[]>(() => cachedHosts);

  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    const refresh = () => {
      const requested = ++generation;
      return product.hosts.list().then((rows) => {
        if (!cancelled && requested === generation) setHosts(rememberHosts(Array.isArray(rows) ? rows : []));
      }).catch(() => {
        if (!cancelled && requested === generation) setHosts(rememberHosts([]));
      });
    };
    refresh();
    const stopReconnect = subscribeProductReconnect(refresh);
    const unsub = product.hosts.onChanged((payload) => {
      if (cancelled) return;
      if (Array.isArray(payload)) {
        generation++;
        setHosts(rememberHosts(payload));
        return;
      }
      refresh();
    });
    return () => {
      cancelled = true;
      stopReconnect();
      unsub();
    };
  }, []);

  return hosts;
}

export function connectedHosts(hosts: Host[]): Host[] {
  return hosts.filter((host) => host.status === 'connected');
}

export function primaryHost(hosts: Host[]): Host | undefined {
  return hosts.find((host) => host.isPrimary);
}

export function defaultHostId(
  hosts: Host[],
  project?: { hostId?: string; remote?: unknown }
): string | undefined {
  // A missing roster row is unavailability, not authority to choose another
  // checkout. Keep a bound identity through disconnect, revocation and refresh.
  if (project?.hostId) return project.hostId;
  if (project?.remote) return undefined;
  return primaryHost(hosts)?.id;
}
