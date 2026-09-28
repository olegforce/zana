import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadThreadModelCatalog } from './thread-model-catalog.js';
import { getModelRefreshState, refreshModels, refreshModelsWithToast, subscribeModelRefresh } from './model-refresh.js';

vi.mock('./thread-model-catalog.js', () => ({ reloadThreadModelCatalog: vi.fn() }));
beforeEach(() => {
  vi.mocked(reloadThreadModelCatalog).mockReset().mockResolvedValue({ failedCatalogs: 0, failedProviders: [] });
});

describe('model recovery feedback', () => {
  it('shares ongoing work, notifies subscribers, and allows another refresh after completion', async () => {
    let release!: (result: { failedCatalogs: number; failedProviders: string[] }) => void;
    vi.mocked(reloadThreadModelCatalog).mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const listener = vi.fn();
    const unsubscribe = subscribeModelRefresh(listener);
    const first = refreshModels();
    expect(getModelRefreshState().running).toBe(true);
    expect(refreshModels()).toBe(first);
    const toast = vi.fn();
    await refreshModelsWithToast(toast);
    expect(toast).toHaveBeenCalledWith('Model refresh is already running.', 'info');
    release({ failedCatalogs: 0, failedProviders: [] });
    await first;
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getModelRefreshState()).toEqual({ running: false, ok: true, message: 'Model lists refreshed.' });
    unsubscribe();
    await refreshModels();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(reloadThreadModelCatalog).toHaveBeenCalledTimes(2);
  });

  it('shows progress and success to palette users', async () => {
    const toast = vi.fn();
    await refreshModelsWithToast(toast);
    expect(toast.mock.calls).toEqual([['Recalculating models…', 'info'], ['Model lists refreshed.', 'info']]);
  });

  it.each([
    { failedCatalogs: 0, failedProviders: ['Codex', 'Pi'] },
    { failedCatalogs: 1, failedProviders: [] }
  ])('reports partial recovery failures: %j', async (result) => {
    vi.mocked(reloadThreadModelCatalog).mockResolvedValueOnce(result);
    const toast = vi.fn();
    await refreshModelsWithToast(toast);
    expect(getModelRefreshState()).toMatchObject({ running: false, ok: false });
    expect(toast).toHaveBeenLastCalledWith(expect.stringContaining('Some model lists could not be refreshed.'), 'error');
    for (const provider of result.failedProviders) expect(getModelRefreshState().message).toContain(provider);
  });

  it('recovers from unexpected failures and permits a retry', async () => {
    vi.mocked(reloadThreadModelCatalog).mockRejectedValueOnce(new Error('network'));
    const result = await refreshModels();
    expect(result).toMatchObject({ running: false, ok: false, message: expect.stringContaining('Could not refresh models.') });
    expect((await refreshModels()).ok).toBe(true);
  });
});
