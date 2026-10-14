/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduledTask } from '@zana-ai/zcc-domain/product';

const h = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), update: vi.fn() }));
vi.mock('../../lib/product-client.js', () => ({ product: { config: { get: h.get, set: h.set }, scheduler: { update: h.update } } }));
vi.mock('../Modal.js', () => ({
  Modal: ({ title, children, footer }: { title: string; children: React.ReactNode; footer?: React.ReactNode }) => (
    <div role="dialog" aria-label={title}>{children}{footer}</div>
  )
}));
import { RecoveryCard, RecoveryDialog } from './RecoveryOptIn.js';

const task = (id: string, over: Partial<ScheduledTask> = {}) => ({ id, name: id, projectId: 'p', ...over }) as unknown as ScheduledTask;
const classic = [task('Alpha'), task('Beta')];

beforeEach(() => {
  h.get.mockReset().mockResolvedValue({});
  h.set.mockReset().mockResolvedValue(undefined);
  h.update.mockReset().mockResolvedValue({ ok: true, value: {} });
});
afterEach(cleanup);

describe('RecoveryCard', () => {
  it('stays hidden until the config resolves, then shows', async () => {
    let resolve!: (v: unknown) => void;
    h.get.mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<RecoveryCard tasks={classic} onReview={vi.fn()} />);
    expect(screen.queryByRole('region', { name: 'Run recovery' })).toBeNull();
    resolve({});
    expect(await screen.findByText('New: missed and failed run recovery.')).toBeTruthy();
  });

  it.each([['dismissed'], ['applied']])('stays hidden when %s', async (value) => {
    h.get.mockResolvedValue({ schedulerRecoveryIntro: value });
    render(<RecoveryCard tasks={classic} onReview={vi.fn()} />);
    await vi.waitFor(() => expect(h.get).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.queryByRole('region', { name: 'Run recovery' })).toBeNull();
  });

  it('stays hidden with no Classic native schedules, or when config fails', async () => {
    const recovery = task('R', { catchUp: { mode: 'once' } });
    const external = task('E', { external: { kind: 'claude-loop' } as ScheduledTask['external'] });
    render(<RecoveryCard tasks={[recovery, external]} onReview={vi.fn()} />);
    await vi.waitFor(() => expect(h.get).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.queryByRole('region', { name: 'Run recovery' })).toBeNull();
    cleanup();
    h.get.mockRejectedValue(new Error('offline'));
    render(<RecoveryCard tasks={classic} onReview={vi.fn()} />);
    await Promise.resolve();
    expect(screen.queryByRole('region', { name: 'Run recovery' })).toBeNull();
  });

  it('hides itself after the dialog applied recovery to only some schedules', async () => {
    const { rerender } = render(<RecoveryCard tasks={classic} onReview={vi.fn()} refreshKey={false} />);
    expect(await screen.findByText('New: missed and failed run recovery.')).toBeTruthy();
    h.get.mockResolvedValue({ schedulerRecoveryIntro: 'applied' });
    rerender(<RecoveryCard tasks={classic} onReview={vi.fn()} refreshKey={true} />);
    await vi.waitFor(() => expect(screen.queryByRole('region', { name: 'Run recovery' })).toBeNull());
  });

  it('Review opens the dialog and Not now persists dismissal', async () => {
    const onReview = vi.fn();
    render(<RecoveryCard tasks={classic} onReview={onReview} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(onReview).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(h.set).toHaveBeenCalledWith({ schedulerRecoveryIntro: 'dismissed' });
    expect(screen.queryByRole('region', { name: 'Run recovery' })).toBeNull();
  });
});

describe('RecoveryDialog', () => {
  it('applies the chosen policy to checked schedules only, then marks applied', async () => {
    const onClose = vi.fn();
    render(<RecoveryDialog tasks={[...classic, task('Gamma', { catchUp: { mode: 'skip' } })]} onClose={onClose} />);
    expect(screen.queryByLabelText('Gamma')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Beta' }));
    fireEvent.change(screen.getByLabelText('Missed runs'), { target: { value: 'all' } });
    fireEvent.change(screen.getByLabelText('Up to', { selector: '#recovery-missed-max' }), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Auto-retry temporary failures' }));
    expect((document.querySelector('#recovery-attempts') as HTMLInputElement).value).toBe('1');
    expect((document.querySelector('#recovery-delay') as HTMLInputElement).value).toBe('10');
    fireEvent.change(document.querySelector('#recovery-attempts')!, { target: { value: '9' } });
    fireEvent.change(document.querySelector('#recovery-delay')!, { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn on for 1 schedule' }));
    expect(await screen.findByText('1 turned on')).toBeTruthy();
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update).toHaveBeenCalledWith('Alpha', { catchUp: { mode: 'all', max: 10 }, retry: { attempts: 5, delayMinutes: 1 } });
    expect(h.set).toHaveBeenCalledWith({ schedulerRecoveryIntro: 'applied' });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('omits retry when off and uses Run once by default; skip is selectable', async () => {
    render(<RecoveryDialog tasks={classic} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Turn on for 2 schedules' }));
    await screen.findByText('2 turned on');
    expect(h.update.mock.calls).toEqual([['Alpha', { catchUp: { mode: 'once' } }], ['Beta', { catchUp: { mode: 'once' } }]]);
    cleanup();
    h.update.mockClear();
    render(<RecoveryDialog tasks={classic} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Missed runs'), { target: { value: 'skip' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn on for 2 schedules' }));
    await screen.findByText('2 turned on');
    expect(h.update.mock.calls[0]![1]).toEqual({ catchUp: { mode: 'skip' } });
  });

  it('reports partial failure by name and still marks applied', async () => {
    h.update.mockResolvedValueOnce({ ok: true, value: {} }).mockResolvedValueOnce({ ok: false, message: 'x' });
    render(<RecoveryDialog tasks={[...classic, task('Gamma')]} onClose={vi.fn()} />);
    h.update.mockRejectedValueOnce(new Error('boom'));
    fireEvent.click(screen.getByRole('button', { name: 'Turn on for 3 schedules' }));
    expect(await screen.findByText('1 turned on')).toBeTruthy();
    expect(screen.getByText('Could not update: Beta, Gamma')).toBeTruthy();
    expect(h.set).toHaveBeenCalledWith({ schedulerRecoveryIntro: 'applied' });
  });

  it('does not mark applied when everything fails', async () => {
    h.update.mockResolvedValue({ ok: false, message: 'x' });
    render(<RecoveryDialog tasks={classic} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Turn on for 2 schedules' }));
    expect(await screen.findByText('0 turned on')).toBeTruthy();
    expect(h.set).not.toHaveBeenCalled();
  });

  it('disables apply with nothing checked, and Cancel changes nothing', () => {
    const onClose = vi.fn();
    render(<RecoveryDialog tasks={[task('Solo')]} onClose={onClose} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Solo' }));
    expect((screen.getByRole('button', { name: 'Turn on for 0 schedules' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
    expect(h.set).not.toHaveBeenCalled();
  });

  it('shows a note when no Classic schedules remain', () => {
    render(<RecoveryDialog tasks={[task('R', { catchUp: { mode: 'once' } })]} onClose={vi.fn()} />);
    expect(screen.getByText('Every schedule already has recovery turned on.')).toBeTruthy();
  });
});
