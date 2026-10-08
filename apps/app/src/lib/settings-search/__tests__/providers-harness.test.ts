import { describe, expect, it } from 'vitest';
import { useData } from '@/store';
import { getSettingsSearchProviders, getSettingsSearchSourcesVersion } from '../registry';
import { harnessSearchProvider, registerHarnessSearchProvider } from '../providers/harness';

describe('harness provider registration', () => {
  it('bumps the sources version when probed harness status lands, ignores other churn, and releases on dispose', () => {
    const before = getSettingsSearchProviders();
    const dispose = registerHarnessSearchProvider();
    try {
      expect(getSettingsSearchProviders()).toContain(harnessSearchProvider);
      const v0 = getSettingsSearchSourcesVersion();
      // The boot probe resolves after a search may already be open.
      useData.setState({ harnessStatus: [...useData.getState().harnessStatus] });
      const v1 = getSettingsSearchSourcesVersion();
      expect(v1).toBeGreaterThan(v0);
      useData.setState({ projects: [...useData.getState().projects] }); // unrelated store churn
      expect(getSettingsSearchSourcesVersion()).toBe(v1);
    } finally {
      dispose();
    }
    expect(getSettingsSearchProviders()).toEqual(before);
    const afterDispose = getSettingsSearchSourcesVersion();
    useData.setState({ harnessStatus: [] });
    expect(getSettingsSearchSourcesVersion()).toBe(afterDispose);
  });
});
