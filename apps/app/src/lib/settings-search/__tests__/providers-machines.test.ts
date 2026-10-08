import { describe, expect, it } from 'vitest';
import { searchSettings } from '../index';
import { getSettingsSearchProviders } from '../registry';
import { machinesSearchProvider, registerMachinesSearchProvider } from '../providers/machines';

const snap = (machines?: Array<{ name: string; host?: string }>) => ({ config: {} as never, machines });

describe('machines provider', () => {
  it('indexes names and hostnames, linking to the Machines page anchor', () => {
    const entries = machinesSearchProvider(snap([{ name: 'Mac Mini', host: 'mini.local' }, { name: 'Build box' }]));
    expect(entries.map((e) => e.id)).toEqual(['machines.machine.mac-mini', 'machines.machine.build-box']);
    expect(entries[0]).toMatchObject({ section: 'machines', anchor: 'machines', kind: 'subsection', label: 'Mac Mini' });
    expect(entries[0].help).toContain('mini.local');
    expect(entries[1].help).toBe('Paired machine.');
  });

  it('is found by name or hostname through the engine', () => {
    const opts = { entries: [], providers: [machinesSearchProvider] };
    const s = snap([{ name: 'Mac Mini', host: 'mini.local' }]);
    expect(searchSettings('mini.local', s, opts)[0].entry.id).toBe('machines.machine.mac-mini');
    expect(searchSettings('mac mini', s, opts)[0].breadcrumb).toBe('Machines');
  });

  it('copes with no machines, blank names and duplicate names', () => {
    expect(machinesSearchProvider(snap())).toEqual([]);
    expect(machinesSearchProvider(snap([{ name: '  ' }]))).toEqual([]);
    const dup = machinesSearchProvider(snap([{ name: 'A' }, { name: 'a' }, { name: '!!!' }]));
    expect(dup.map((e) => e.id)).toEqual(['machines.machine.a', 'machines.machine.a-1', 'machines.machine.machine']);
  });

  it('registers and unregisters', () => {
    const before = getSettingsSearchProviders();
    const off = registerMachinesSearchProvider();
    expect(getSettingsSearchProviders()).toContain(machinesSearchProvider);
    off();
    expect(getSettingsSearchProviders()).toEqual(before);
  });
});
