// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { HostMachinePicker } from './HostMachinePicker.js';
import type { Host } from '@zana-ai/zcc-domain/thread-runtime';
vi.mock('@/components/ui/PopoverPicklist', () => ({ PopoverPicklist: (props: any) => <select aria-label={props.ariaLabel} value={props.value} onChange={event => props.onChange(event.target.value)}>
  <option value="">{props.placeholder}</option>{props.options.map((row: any) => <option key={row.value} value={row.value}>{row.label}</option>)}
</select> }));
afterEach(cleanup);
const hosts = [{ id: 'a', name: 'Laptop', isPrimary: true, status: 'connected' }, { id: 'b', name: 'Devbox', isPrimary: false, status: 'disconnected' }] as Host[];
it('shows no replacement until the user chooses it after the selected host disappears', () => {
  const change = vi.fn();
  render(<HostMachinePicker hosts={hosts} value="b" onChange={change} />);
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('');
  expect(change).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'a' } });
  expect(change).toHaveBeenCalledWith('a');
});
it('keeps an offline selected machine visible when requested', () => {
  render(<HostMachinePicker hosts={hosts} value="b" onChange={vi.fn()} includeDisconnected alwaysShow />);
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('b');
  expect(screen.getByRole('option', { name: 'Primary machine' })).toBeTruthy();
});
it('hides an unnecessary single-machine picker, but preserves an explicit choice', () => {
  const view = render(<HostMachinePicker hosts={hosts.slice(0, 1)} value="a" onChange={vi.fn()} />);
  expect(screen.queryByRole('combobox')).toBeNull();
  view.rerender(<HostMachinePicker hosts={hosts.slice(0, 1)} onChange={vi.fn()} alwaysShow />);
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('');
  view.rerender(<HostMachinePicker hosts={[]} onChange={vi.fn()} alwaysShow />);
  expect(screen.queryByRole('combobox')).toBeNull();
});
