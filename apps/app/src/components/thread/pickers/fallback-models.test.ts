import { describe, expect, it } from 'vitest';
import {
  composerProvidersFromCatalog,
  fallbackModelsForProvider,
  fallbackMoreModelsForProvider,
  fallbackProviderOption,
  fallbackProvidersForNewThread,
  isOfferedModernProvider,
  snapNewThreadProviderId
} from './fallback-models.js';

describe('fallback thread catalogs', () => {
  it('keeps provider chrome but no renderer-owned model catalog', () => {
    expect(fallbackModelsForProvider('claude-code')).toEqual([]);
    expect(fallbackProviderOption('claude-code').displayName).toBe('Claude Code');
    expect(fallbackProviderOption('claude-code').composerActions).toEqual(['plan']);
    expect(fallbackProviderOption('codex').composerActions).toEqual(['plan', 'goal']);
  });

  it('waits for live discovery before showing provider aliases', () => {
    expect(fallbackMoreModelsForProvider('claude-code')).toEqual([]);
    expect(fallbackMoreModelsForProvider('codex')).toEqual([]);
  });

  it('does not seed models for any provider in the renderer', () => {
    expect(fallbackModelsForProvider('codex')).toEqual([]);
    expect(fallbackModelsForProvider('acp-cursor')).toEqual([]);
    expect(fallbackModelsForProvider('pi')).toEqual([]);
    expect(fallbackModelsForProvider('acp-opencode')).toEqual([]);
    expect(fallbackModelsForProvider('acp-grok')).toEqual([]);
    expect(fallbackModelsForProvider('acp-mastracode')).toEqual([]);
    expect(fallbackModelsForProvider('acp-afcode')).toEqual([]);
    expect(fallbackProviderOption('acp-opencode').displayName).toBe('OpenCode');
    expect(fallbackProviderOption('acp-grok').displayName).toBe('Grok Build');
    expect(fallbackProviderOption('acp-grok').permissionModes).toEqual(['accept-edits', 'full']);
    expect(fallbackProviderOption('acp-mastracode').displayName).toBe('Mastra Code');
  });

  it('seeds every builtin harness on a new thread and locks to one on an existing thread', () => {
    expect(fallbackProvidersForNewThread().map((row) => row.id)).toEqual([
      'claude-code',
      'codex',
      'pi',
      'acp-cursor'
    ]);
    expect(composerProvidersFromCatalog([], false, 'claude-code').map((row) => row.id)).toEqual([
      'claude-code',
      'codex',
      'pi',
      'acp-cursor'
    ]);
    expect(composerProvidersFromCatalog([], true, 'codex').map((row) => row.id)).toEqual(['codex']);
    expect(composerProvidersFromCatalog(
      [{ id: 'claude-code', displayName: 'Claude', permissionModes: ['full'], composerActions: ['plan'] }],
      false,
      'claude-code'
    )[0]).toMatchObject({ displayName: 'Claude', composerActions: ['plan'] });
    expect(composerProvidersFromCatalog(
      [
        { id: 'claude-code', displayName: 'Claude Code', permissionModes: ['full'], composerActions: [] },
        { id: 'custom-agent', displayName: 'Custom', permissionModes: ['full'], composerActions: [] }
      ],
      false,
      'claude-code'
    ).map((row) => row.id)).toEqual(['claude-code', 'custom-agent']);
    expect(composerProvidersFromCatalog(
      [{ id: 'pi', displayName: 'Pi', permissionModes: ['full'], composerActions: [] }],
      true,
      'claude-code'
    ).map((row) => row.id)).toEqual(['pi']);
  });

  it('does not keep offering a builtin the live catalog omitted', () => {
    expect(composerProvidersFromCatalog(
      [{ id: 'acp-cursor', displayName: 'Cursor', permissionModes: ['full'], composerActions: [] }],
      false,
      'claude-code'
    ).map((row) => row.id)).toEqual(['acp-cursor']);
  });

  it('blocks a new-thread send unless the live roster includes the selected harness', () => {
    expect(isOfferedModernProvider(['acp-cursor', 'pi'], 'claude-code')).toBe(false);
    expect(isOfferedModernProvider(['claude-code', 'acp-cursor'], 'claude-code')).toBe(true);
    expect(isOfferedModernProvider(['claude-code'], undefined)).toBe(false);
  });

  it('snaps off a remembered id the live roster no longer offers', () => {
    const loading = composerProvidersFromCatalog([], false, 'acp-cursor').map((row) => row.id);
    expect(snapNewThreadProviderId(loading, 'acp-cursor')).toBeNull();
    const live = composerProvidersFromCatalog(
      [{ id: 'claude-code', displayName: 'Claude Code', permissionModes: ['full'], composerActions: [] }],
      false,
      'acp-cursor'
    ).map((row) => row.id);
    expect(snapNewThreadProviderId(live, 'claude-code')).toBeNull();
    expect(snapNewThreadProviderId(live, 'acp-cursor')).toBe('claude-code');
    expect(snapNewThreadProviderId(live, 'gone-plugin')).toBe('claude-code');
    expect(snapNewThreadProviderId(['pi', 'codex', 'claude-code'], 'gone-plugin', 'codex')).toBe('codex');
    expect(snapNewThreadProviderId(['pi', 'claude-code'], 'gone-plugin', 'codex')).toBe('pi');
    expect(snapNewThreadProviderId([], 'acp-cursor')).toBeNull();
  });
});
