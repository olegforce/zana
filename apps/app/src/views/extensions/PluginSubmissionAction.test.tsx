// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionEntry, PluginAppEntry } from '@zana-ai/zcc-domain/product';
import type { HubRow } from './installed-plugins.js';
import { canSubmitPlugin, pluginSubmissionNavigation } from './plugin-submission.js';

const state = vi.hoisted(() => ({ selectedProjectId: null as string | null }));
vi.mock('@/store', () => ({ useUi: (pick: (value: typeof state) => unknown) => pick(state) }));
import { PluginSubmissionAction } from './PluginSubmissionAction.js';

function row(provenance?: PluginAppEntry['provenance'], source?: ExtensionEntry['source']): HubRow {
  return {
    module: { id: 'force2you', title: 'Force2You', icon: 'Cloud' },
    plugin: provenance ? { id: 'force2you', provenance } as PluginAppEntry : null,
    entry: source ? { source } as ExtensionEntry : null
  };
}
function Location() {
  const location = useLocation();
  return <output data-testid="destination">{JSON.stringify({ pathname: location.pathname, state: location.state })}</output>;
}
afterEach(() => { cleanup(); state.selectedProjectId = null; });

describe('plugin submission eligibility', () => {
  it('offers direct installs even when their frontend is absent or the plugin is disabled', () => {
    const direct = row('direct');
    Object.assign(direct.plugin!, { enabled: false, status: 'disabled', appUrl: null });
    expect(canSubmitPlugin(direct)).toBe(true);
  });
  it.each(['builtin', 'catalog'] as const)('keeps %s publisher-owned installs out, including stale local records', (provenance) => {
    expect(canSubmitPlugin(row(provenance, 'local'))).toBe(false);
  });
  it.each(['local', 'git'] as const)('offers a legacy %s source', (source) => {
    expect(canSubmitPlugin(row(undefined, source))).toBe(true);
  });
  it('excludes a compiled module without an install record', () => {
    expect(canSubmitPlugin(row())).toBe(false);
  });
});

describe('PluginSubmissionAction', () => {
  it.each(['builtin', 'catalog'] as const)('renders no submission control for %s', (provenance) => {
    render(<MemoryRouter><PluginSubmissionAction row={row(provenance)} onChoose={vi.fn()} /></MemoryRouter>);
    expect(screen.queryByRole('menuitem')).toBeNull();
  });
  it.each([null, 'project-1'])('opens a focused draft in project %s without sending it', (projectId) => {
    state.selectedProjectId = projectId;
    const onChoose = vi.fn();
    render(<MemoryRouter initialEntries={['/extensions/plugins/force2you?view=installed']}>
      <PluginSubmissionAction row={row('direct')} onChoose={onChoose} /><Location />
    </MemoryRouter>);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Submit to marketplace' }));
    expect(onChoose).toHaveBeenCalledOnce();
    const destination = JSON.parse(screen.getByTestId('destination').textContent!);
    expect(destination).toEqual(pluginSubmissionNavigation(row('direct'), projectId));
    expect(destination.state.focusPrompt).toBe(true);
    expect(destination.state.initialPrompt).toContain('submit-a-plugin');
    expect(destination.state.initialPrompt).toContain('"id":"force2you"');
    expect(destination.state.initialPrompt).toContain('public or internal visibility');
    expect(destination.state.initialPrompt).toContain('approval of release changes');
    expect(destination.state.initialPrompt).toContain("Do not change the installed plugin's settings");
  });
  it('encodes identity as data without including private install paths', () => {
    const unusual = row('direct');
    unusual.module.title = 'Name "quoted"\nwith newline';
    const { state: draft } = pluginSubmissionNavigation(unusual);
    expect(draft.initialPrompt).toContain(JSON.stringify({ id: 'force2you', name: unusual.module.title }));
    expect(draft.initialPrompt).not.toContain('/Users/');
  });
});
