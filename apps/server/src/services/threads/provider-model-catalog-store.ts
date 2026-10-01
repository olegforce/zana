import { createHash } from 'node:crypto';
import {
  ProviderListModelsResultSchema,
  type HostBridgeLaunch,
  type ProviderListModelsResult
} from '@zana-ai/zcc-contracts/host-rpc';
import {
  getProviderModelCatalog,
  putProviderModelCatalog,
  type ZccDatabase
} from '@zana-ai/zcc-db';
import { classifyModelListError, modelListErrorDetail, type ThreadModelLoadErrorCode } from './thread-execution-options.js';

export const PROVIDER_MODEL_CATALOG_FRESH_MS = 5 * 60_000;
export const PROVIDER_MODEL_VALIDATION_REFRESH_MS = 60_000;
export const PROVIDER_MODEL_FAILURE_TTL_MS = 30_000;
export const PROVIDER_MODEL_PREWARM_REFRESH_MS = 4 * 60 * 60_000;
export const PROVIDER_MODEL_WORKSPACE_RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_MEMORY_CATALOGS = 256;

export interface ProviderModelCatalogRequest {
  hostId: string;
  providerId: string;
  scope: 'host' | 'workspace';
  cwd?: string;
  bridgeLaunch: HostBridgeLaunch;
  forceRefresh?: boolean;
  requiredModel?: string | null;
  prewarm?: boolean;
}

export interface ProviderModelCatalogResult extends ProviderListModelsResult {
  modelLoadError: {
    providerId: string;
    code: Exclude<ThreadModelLoadErrorCode, 'provider_unavailable'>;
    detail: string | null;
  } | null;
}

interface MemoryEntry extends ProviderListModelsResult {
  fingerprint: string;
  fetchedAt: number;
  lastUsedAt: number;
  failure?: { code: Exclude<ThreadModelLoadErrorCode, 'provider_unavailable'>; detail: string | null; at: number };
}

interface ProviderModelCatalogStoreOptions {
  db: ZccDatabase;
  callHostOnlineRpc(input: {
    hostId: string;
    timeoutMs: number;
    command: {
      type: 'provider.list_models';
      providerId: string;
      bridgeLaunch: HostBridgeLaunch;
      cwd?: string;
    };
  }): Promise<ProviderListModelsResult>;
  onChanged?: (payload: { hostId: string; providerId: string; scopeKey: string }) => void;
  now?: () => number;
}

function launchFingerprint(providerId: string, launch: HostBridgeLaunch): string {
  return createHash('sha256').update(JSON.stringify([providerId, launch])).digest('hex');
}

function modelPresent(entry: Pick<ProviderListModelsResult, 'models' | 'selectedOnlyModels'>, model: string): boolean {
  return [...entry.models, ...entry.selectedOnlyModels].some((row) => row.id === model || row.model === model);
}

export class ProviderModelCatalogStore {
  private readonly memory = new Map<string, MemoryEntry>();
  private readonly pending = new Map<string, Promise<ProviderModelCatalogResult>>();
  private readonly now: () => number;

  constructor(private readonly options: ProviderModelCatalogStoreOptions) {
    this.now = options.now ?? Date.now;
  }

  async read(request: ProviderModelCatalogRequest): Promise<ProviderModelCatalogResult> {
    const scopeKey = request.scope === 'workspace' ? request.cwd?.trim() ?? '' : '';
    const key = JSON.stringify([request.hostId, request.providerId, scopeKey]);
    const fingerprint = launchFingerprint(request.providerId, request.bridgeLaunch);
    const now = this.now();
    let entry = this.memory.get(key);
    if (!entry) {
      const stored = getProviderModelCatalog(this.options.db, {
        hostId: request.hostId,
        providerId: request.providerId,
        scopeKey
      });
      const parsed = stored ? ProviderListModelsResultSchema.safeParse({
        models: stored.models,
        selectedOnlyModels: stored.selectedOnlyModels,
        ...(stored.acpMode ? { acpMode: stored.acpMode } : {})
      }) : null;
      if (stored && stored.fingerprint === fingerprint && parsed?.success) {
        entry = {
          ...parsed.data,
          fingerprint,
          fetchedAt: stored.fetchedAt,
          lastUsedAt: now
        };
        this.memory.set(key, entry);
      }
    }
    if (entry) entry.lastUsedAt = now;
    const requiredMissing = Boolean(request.requiredModel && entry && !modelPresent(entry, request.requiredModel));
    const refreshAge = request.prewarm
      ? PROVIDER_MODEL_PREWARM_REFRESH_MS
      : requiredMissing ? PROVIDER_MODEL_VALIDATION_REFRESH_MS : PROVIDER_MODEL_CATALOG_FRESH_MS;
    const fresh = entry?.fingerprint === fingerprint && now - entry.fetchedAt < refreshAge;
    const recentFailure = entry?.failure && now - entry.failure.at < PROVIDER_MODEL_FAILURE_TTL_MS;
    if (!request.forceRefresh && (fresh || recentFailure)) return this.response(request.providerId, entry);

    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    const load = this.refresh(request, scopeKey, key, fingerprint, entry).finally(() => {
      if (this.pending.get(key) === load) this.pending.delete(key);
    });
    this.pending.set(key, load);
    return load;
  }

  invalidate(input?: { hostId?: string; providerId?: string }): void {
    for (const [key, entry] of this.memory) {
      const [hostId, providerId] = JSON.parse(key) as [string, string, string];
      if (input?.hostId && input.hostId !== hostId) continue;
      if (input?.providerId && input.providerId !== providerId) continue;
      entry.fetchedAt = 0;
      entry.failure = undefined;
    }
  }

  private async refresh(
    request: ProviderModelCatalogRequest,
    scopeKey: string,
    key: string,
    fingerprint: string,
    previous: MemoryEntry | undefined
  ): Promise<ProviderModelCatalogResult> {
    try {
      const listed = await this.options.callHostOnlineRpc({
        hostId: request.hostId,
        timeoutMs: 45_000,
        command: {
          type: 'provider.list_models',
          providerId: request.providerId,
          bridgeLaunch: request.bridgeLaunch,
          ...(request.scope === 'workspace' && request.cwd ? { cwd: request.cwd } : {})
        }
      });
      const now = this.now();
      const next: MemoryEntry = {
        ...listed,
        fingerprint,
        fetchedAt: now,
        lastUsedAt: now
      };
      const changed = !previous
        || JSON.stringify([previous.models, previous.selectedOnlyModels, previous.acpMode])
          !== JSON.stringify([next.models, next.selectedOnlyModels, next.acpMode]);
      this.memory.set(key, next);
      this.evictMemory();
      try {
        putProviderModelCatalog(this.options.db, {
          hostId: request.hostId,
          providerId: request.providerId,
          scopeKey,
          fingerprint,
          models: next.models,
          selectedOnlyModels: next.selectedOnlyModels,
          ...(next.acpMode ? { acpMode: next.acpMode } : {}),
          fetchedAt: now
        }, now - PROVIDER_MODEL_WORKSPACE_RETENTION_MS);
      } catch {
        // A persistence failure must not discard a successfully discovered live catalog.
      }
      if (changed) this.options.onChanged?.({ hostId: request.hostId, providerId: request.providerId, scopeKey });
      return this.response(request.providerId, next);
    } catch (error) {
      const failure = {
        code: classifyModelListError(error),
        detail: modelListErrorDetail(error),
        at: this.now()
      };
      if (previous) {
        previous.failure = failure;
        previous.lastUsedAt = failure.at;
        return this.response(request.providerId, previous);
      }
      return {
        models: [],
        selectedOnlyModels: [],
        modelLoadError: { providerId: request.providerId, code: failure.code, detail: failure.detail }
      };
    }
  }

  private response(providerId: string, entry: MemoryEntry | undefined): ProviderModelCatalogResult {
    const unusable = entry?.failure?.code === 'auth_required' || entry?.failure?.code === 'missing_executable';
    return {
      models: unusable ? [] : entry?.models ?? [],
      selectedOnlyModels: unusable ? [] : entry?.selectedOnlyModels ?? [],
      ...(!unusable && entry?.acpMode ? { acpMode: entry.acpMode } : {}),
      modelLoadError: entry?.failure
        ? { providerId, code: entry.failure.code, detail: entry.failure.detail }
        : null
    };
  }

  private evictMemory(): void {
    if (this.memory.size <= MAX_MEMORY_CATALOGS) return;
    const oldest = [...this.memory.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    for (const [key] of oldest.slice(0, this.memory.size - MAX_MEMORY_CATALOGS)) this.memory.delete(key);
  }
}
