import { useEffect, useMemo, useState } from 'react';
import type { AppConfig, ProjectSettings } from '@zana-ai/zcc-domain/product';
import { product } from '../product-client.js';
import type { SettingsValueSnapshot } from './types';

export interface SnapshotParts {
  config: AppConfig | null;
  project: { id: string; settings: ProjectSettings } | null;
  machines: ReadonlyArray<{ name: string; host?: string }> | null;
}

const EMPTY_CONFIG = {} as AppConfig;

/** Pure assembly. Identity changes only when an input does (the corpus memoises on it). */
export function buildSettingsSnapshot(parts: SnapshotParts): SettingsValueSnapshot {
  const snapshot: SettingsValueSnapshot = { config: parts.config ?? EMPTY_CONFIG };
  if (parts.project) snapshot.project = parts.project;
  if (parts.machines) snapshot.machines = parts.machines;
  return snapshot;
}

/**
 * Value snapshot for Settings search from data the renderer already reads
 * (config, project settings, paired machines). Nothing is fetched until
 * `enabled` (first focus of the search box), and nothing is persisted.
 */
export function useSettingsSnapshot(projectId: string | null, enabled: boolean): SettingsValueSnapshot {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [project, setProject] = useState<SnapshotParts['project']>(null);
  const [machines, setMachines] = useState<SnapshotParts['machines']>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    product.config.get().then((next) => { if (!cancelled) setConfig(next); }).catch(() => {});
    const off = product.config.onChanged((next) => { if (!cancelled) setConfig(next); });
    product.hosts.list()
      .then((hosts) => {
        if (!cancelled) setMachines(hosts.map((h) => ({ name: h.name, host: h.sshHost ?? undefined })));
      })
      .catch(() => {});
    return () => { cancelled = true; off(); };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !projectId) {
      setProject(null);
      return;
    }
    let cancelled = false;
    const load = (id: string) => {
      product.projectSettings.get(id)
        .then((settings) => { if (!cancelled) setProject({ id, settings }); })
        .catch(() => {});
    };
    load(projectId);
    const off = product.projectSettings.onChanged((changed) => { if (changed === projectId) load(projectId); });
    return () => { cancelled = true; off(); };
  }, [enabled, projectId]);

  return useMemo(() => buildSettingsSnapshot({ config, project, machines }), [config, project, machines]);
}
