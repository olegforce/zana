// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LaunchModeSegmented } from './LaunchModeSegmented.js';

afterEach(cleanup);

describe('LaunchModeSegmented', () => {
  it('renders one Team choice and selects it', () => {
    const onChange = vi.fn();
    render(<LaunchModeSegmented value="thread" onChange={onChange} showTeam />);
    expect(screen.getByRole('button', { name: 'Squad' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Autonomous Team|Job Team/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Squad' }));
    expect(onChange).toHaveBeenCalledWith('team');
  });

  it('hides Team when disabled', () => {
    render(<LaunchModeSegmented value="thread" onChange={() => undefined} showTeam={false} />);
    expect(screen.queryByRole('button', { name: 'Squad' })).toBeNull();
  });

  it('keeps distinct tip anchors on CLI Agent and Modern while preserving mode selection', () => {
    const onChange = vi.fn();
    const { rerender } = render(<LaunchModeSegmented value="agent" onChange={onChange} showTeam />);
    const cli = screen.getByRole('button', { name: 'CLI Agent' });
    const modern = screen.getByRole('button', { name: 'Modern' });
    expect(cli.getAttribute('data-launch-mode')).toBe('agent');
    expect(modern.getAttribute('data-launch-mode')).toBe('thread');
    fireEvent.click(cli);
    fireEvent.click(modern);
    expect(onChange.mock.calls).toEqual([['agent'], ['thread']]);
    rerender(<LaunchModeSegmented value="team" onChange={onChange} showCliAgent={false} showModern={false} showTeam />);
    expect(screen.queryByRole('button', { name: 'CLI Agent' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Modern' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Squad' }).getAttribute('aria-pressed')).toBe('true');
  });
});
