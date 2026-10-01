import type { AvailableModel } from '@zana-ai/zcc-domain/thread-runtime';
import type { ZccDatabase } from '../connection.js';

export interface ProviderModelCatalogKey {
  hostId: string;
  providerId: string;
  scopeKey: string;
}

export interface StoredProviderModelCatalog extends ProviderModelCatalogKey {
  fingerprint: string;
  models: AvailableModel[];
  selectedOnlyModels: AvailableModel[];
  acpMode?: { currentValue?: string; options: Array<{ value: string; name?: string }> };
  fetchedAt: number;
}

interface ProviderModelCatalogRow {
  hostId: string;
  providerId: string;
  scopeKey: string;
  fingerprint: string;
  modelsJson: string;
  selectedOnlyModelsJson: string;
  acpModeJson: string | null;
  fetchedAt: number;
}

export function getProviderModelCatalog(
  db: ZccDatabase,
  key: ProviderModelCatalogKey
): StoredProviderModelCatalog | null {
  const row = db.sqlite.prepare(`SELECT host_id AS hostId, provider_id AS providerId,
      scope_key AS scopeKey, fingerprint, models_json AS modelsJson,
      selected_only_models_json AS selectedOnlyModelsJson, acp_mode_json AS acpModeJson,
      fetched_at AS fetchedAt
    FROM provider_model_catalogs WHERE host_id = ? AND provider_id = ? AND scope_key = ?`)
    .get(key.hostId, key.providerId, key.scopeKey) as ProviderModelCatalogRow | undefined;
  if (!row) return null;
  try {
    return {
      hostId: row.hostId,
      providerId: row.providerId,
      scopeKey: row.scopeKey,
      fingerprint: row.fingerprint,
      models: JSON.parse(row.modelsJson) as AvailableModel[],
      selectedOnlyModels: JSON.parse(row.selectedOnlyModelsJson) as AvailableModel[],
      ...(row.acpModeJson ? { acpMode: JSON.parse(row.acpModeJson) as StoredProviderModelCatalog['acpMode'] } : {}),
      fetchedAt: row.fetchedAt
    };
  } catch {
    return null;
  }
}

export function putProviderModelCatalog(
  db: ZccDatabase,
  value: StoredProviderModelCatalog,
  workspaceRetentionCutoff: number
): void {
  db.transaction(() => {
    db.sqlite.prepare(`INSERT INTO provider_model_catalogs (
        host_id, provider_id, scope_key, fingerprint, models_json,
        selected_only_models_json, acp_mode_json, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(host_id, provider_id, scope_key) DO UPDATE SET
        fingerprint = excluded.fingerprint,
        models_json = excluded.models_json,
        selected_only_models_json = excluded.selected_only_models_json,
        acp_mode_json = excluded.acp_mode_json,
        fetched_at = excluded.fetched_at`)
      .run(
        value.hostId,
        value.providerId,
        value.scopeKey,
        value.fingerprint,
        JSON.stringify(value.models),
        JSON.stringify(value.selectedOnlyModels),
        value.acpMode ? JSON.stringify(value.acpMode) : null,
        value.fetchedAt
      );
    db.sqlite.prepare(`DELETE FROM provider_model_catalogs
      WHERE scope_key <> '' AND fetched_at < ?`).run(workspaceRetentionCutoff);
  });
}
