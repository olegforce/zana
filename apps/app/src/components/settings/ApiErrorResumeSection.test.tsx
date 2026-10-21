// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@zana-ai/zcc-domain/product';
import { ApiErrorResumeSection } from './ApiErrorResumeSection';

const base = { version: 1, theme: 'system', shell: '/bin/zsh', claudeBinary: 'claude', fontSize: 13, lastProjectId: null } as AppConfig;
const rule = (o: object = {}) => ({ id: 'a', match: 'overloaded', matchMode: 'contains', message: 'continue', delaySeconds: 20, enabled: true, ...o });
const on = (rules: object[] = [], extra: object = {}) =>
  ({ ...base, apiErrorResume: { enabled: true, rules, maxPerWindow: 3, windowMinutes: 15, ...extra } }) as AppConfig;

function setup(config: AppConfig) {
  const onUpdate = vi.fn().mockResolvedValue(undefined);
  const onConfigDraft = vi.fn();
  render(<ApiErrorResumeSection config={config} onUpdate={onUpdate} onConfigDraft={onConfigDraft} />);
  return { onUpdate, onConfigDraft };
}

const check = vi.fn();
beforeEach(() => { (window as any).cc = { apiErrorResume: { check } }; check.mockReset(); });
afterEach(() => { cleanup(); delete (window as any).cc; });

describe('ApiErrorResumeSection', () => {
  it('toggle sends a whole object', () => {
    const { onUpdate } = setup(base);
    fireEvent.click(screen.getByRole('switch', { name: 'Resume after matching API errors' }));
    expect(onUpdate).toHaveBeenCalledWith({ apiErrorResume: { enabled: true, rules: [], maxPerWindow: 3, windowMinutes: 15 } });
    expect(screen.queryByText('Add rule')).toBeNull();
  });

  it('a suggestion adds its rule and its button hides once present', () => {
    const { onUpdate } = setup(on());
    fireEvent.click(screen.getByText('+ Provider anthropic not found'));
    const sent = onUpdate.mock.calls[0][0].apiErrorResume;
    expect(sent.rules).toHaveLength(1);
    expect(sent.rules[0]).toMatchObject({ match: 'Provider anthropic not found', matchMode: 'contains', message: 'continue', delaySeconds: 20 });
    cleanup();
    setup(on([rule({ match: 'provider ANTHROPIC not found' })]));
    expect(screen.queryByText('+ Provider anthropic not found')).toBeNull();
    expect(screen.getByText('+ Connection lost mid-response')).toBeTruthy();
  });

  it('Add rule adds a local draft row that saves once it is valid', () => {
    const { onUpdate } = setup(on());
    fireEvent.click(screen.getByText('Add rule'));
    expect(onUpdate).not.toHaveBeenCalled();
    const input = screen.getByLabelText('When the error matches (rule 1)');
    fireEvent.change(input, { target: { value: 'ab' } });
    fireEvent.blur(input);
    expect(onUpdate).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('At least 4 characters');
    fireEvent.change(input, { target: { value: 'rate limited' } });
    fireEvent.blur(input);
    expect(onUpdate.mock.calls[0][0].apiErrorResume.rules.map((r: any) => r.match)).toEqual(['rate limited']);
    expect(screen.queryByLabelText('When the error matches (rule 2)')).toBeNull();
  });

  it('a blank draft row can be removed and survives a suggestion click', () => {
    const { onUpdate } = setup(on());
    fireEvent.click(screen.getByText('Add rule'));
    fireEvent.click(screen.getByText('+ Provider anthropic not found'));
    expect(onUpdate.mock.calls[0][0].apiErrorResume.rules).toHaveLength(1);
    expect(screen.getByLabelText('When the error matches (rule 1)')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Remove rule 1'));
    expect(screen.queryByLabelText('When the error matches (rule 1)')).toBeNull();
  });

  it('keeps the saved version of a rule that is mid-edit when something else saves', () => {
    const saved = rule({ id: 'a', matchMode: 'regex', match: 'claude-(a|b)' });
    const other = rule({ id: 'b', match: 'second rule' });
    const mid = { ...saved, match: 'claude-(' };
    const { onUpdate } = setup(on([mid, other]));
    // first render saw only the broken version: nothing valid to fall back on
    fireEvent.click(screen.getByLabelText('Remove rule 2'));
    expect(onUpdate.mock.calls[0][0].apiErrorResume.rules).toEqual([]);
    cleanup();
    const view = render(<ApiErrorResumeSection config={on([saved, other])} onUpdate={onUpdate} onConfigDraft={vi.fn()} />);
    view.rerender(<ApiErrorResumeSection config={on([mid, other])} onUpdate={onUpdate} onConfigDraft={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Remove rule 2'));
    const sent = onUpdate.mock.calls[1][0].apiErrorResume.rules;
    expect(sent).toEqual([saved]);
  });

  it('typing drafts and blur saves a valid rule', () => {
    const { onUpdate, onConfigDraft } = setup(on([rule()]));
    const input = screen.getByLabelText('When the error matches (rule 1)');
    fireEvent.change(input, { target: { value: 'rate limited' } });
    expect(onConfigDraft.mock.calls[0][0].apiErrorResume.rules[0].match).toBe('rate limited');
    fireEvent.change(screen.getByLabelText('Send (rule 1)'), { target: { value: 'go on' } });
    fireEvent.blur(screen.getByLabelText('Send (rule 1)'));
    expect(onUpdate.mock.calls[0][0].apiErrorResume.rules).toHaveLength(1);
  });

  it('shows an alert and does not save an invalid regex or a short match', () => {
    const { onUpdate } = setup(on([rule({ matchMode: 'regex', match: '(oops' }), rule({ id: 'b', match: 'abc' })]));
    const alerts = screen.getAllByRole('alert').map((a) => a.textContent);
    expect(alerts).toEqual(['Not a valid regular expression', 'At least 4 characters']);
    fireEvent.blur(screen.getByLabelText('When the error matches (rule 1)'));
    fireEvent.blur(screen.getByLabelText('When the error matches (rule 2)'));
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('toggling the regex box saves when valid', () => {
    const { onUpdate, onConfigDraft } = setup(on([rule()]));
    fireEvent.click(screen.getByLabelText('Regex (rule 1)'));
    expect(onConfigDraft.mock.calls[0][0].apiErrorResume.rules[0].matchMode).toBe('regex');
    expect(onUpdate.mock.calls[0][0].apiErrorResume.rules[0].matchMode).toBe('regex');
  });

  it('removes a rule', () => {
    const { onUpdate } = setup(on([rule(), rule({ id: 'b', match: 'second rule' })]));
    fireEvent.click(screen.getByLabelText('Remove rule 1'));
    expect(onUpdate.mock.calls[0][0].apiErrorResume.rules.map((r: any) => r.id)).toEqual(['b']);
  });

  it('clamps the delay and the cap inputs', () => {
    const { onUpdate, onConfigDraft } = setup(on([rule()]));
    const delay = screen.getByLabelText('After (seconds) (rule 1)');
    fireEvent.change(delay, { target: { value: '30' } });
    expect(onConfigDraft.mock.calls[0][0].apiErrorResume.rules[0].delaySeconds).toBe(30);
    fireEvent.change(delay, { target: { value: '' } });
    fireEvent.blur(delay, { target: { value: '9999' } });
    expect(onUpdate.mock.calls[0][0].apiErrorResume.rules[0].delaySeconds).toBe(600);
    fireEvent.blur(delay, { target: { value: '1' } });
    expect(onUpdate.mock.calls[1][0].apiErrorResume.rules[0].delaySeconds).toBe(5);
    fireEvent.blur(delay, { target: { value: 'x' } });
    expect(onUpdate.mock.calls[2][0].apiErrorResume.rules[0].delaySeconds).toBe(20);

    const per = screen.getByLabelText('Messages before stopping');
    const mins = screen.getByLabelText('Minutes in the window');
    fireEvent.change(per, { target: { value: '5' } });
    fireEvent.change(mins, { target: { value: '30' } });
    fireEvent.change(per, { target: { value: '' } });
    fireEvent.change(mins, { target: { value: '' } });
    fireEvent.blur(per, { target: { value: '99' } });
    expect(onUpdate).toHaveBeenLastCalledWith({ apiErrorResume: expect.objectContaining({ maxPerWindow: 10 }) });
    fireEvent.blur(mins, { target: { value: '1' } });
    expect(onUpdate).toHaveBeenLastCalledWith({ apiErrorResume: expect.objectContaining({ windowMinutes: 5 }) });
    fireEvent.blur(per, { target: { value: 'x' } });
    expect(onUpdate).toHaveBeenLastCalledWith({ apiErrorResume: expect.objectContaining({ maxPerWindow: 3 }) });
  });

  it('Check reports a match, no match and a skipped rule', async () => {
    setup(on([rule(), rule({ id: 'b', match: 'second rule', matchMode: 'regex' })]));
    fireEvent.change(screen.getByLabelText('Error text to check'), { target: { value: 'Overloaded' } });
    check.mockResolvedValueOnce({ ruleId: 'b', message: 'go', delaySeconds: 7, skipped: [] });
    fireEvent.click(screen.getByText('Check'));
    await screen.findByText('Matches rule 2: Zana would send “go” after 7 s.');
    expect(check).toHaveBeenCalledWith({ text: 'Overloaded', rules: expect.any(Array) });
    check.mockResolvedValueOnce({ ruleId: 'a', skipped: [] });
    fireEvent.click(screen.getByText('Check'));
    await screen.findByText('Matches rule 1: Zana would send “continue” after 20 s.');
    check.mockResolvedValueOnce({ ruleId: null, skipped: [] });
    fireEvent.click(screen.getByText('Check'));
    await screen.findByText('No rule matches. Zana would leave the agent waiting for you.');
    check.mockResolvedValueOnce({ ruleId: null, skipped: [{ ruleId: 'b', reason: 'timeout' }, { ruleId: 'a', reason: 'unavailable' }] });
    fireEvent.click(screen.getByText('Check'));
    await screen.findByText('Rule 2 took too long to check and was skipped. Rule 1 could not be checked right now. Try again.');
  });

  it('numbers the matching rule by its row even when an earlier row is invalid', async () => {
    setup(on([rule({ id: 'bad', match: 'ab' }), rule({ id: 'good', match: 'second rule' })]));
    check.mockResolvedValueOnce({ ruleId: 'good', message: 'continue', delaySeconds: 20, skipped: [] });
    fireEvent.click(screen.getByText('Check'));
    await screen.findByText(/Matches rule 2:/);
  });

  it('ignores an older Check answer that arrives after a newer one', async () => {
    setup(on([rule()]));
    let first!: (v: unknown) => void;
    check.mockImplementationOnce(() => new Promise((r) => { first = r; }));
    check.mockResolvedValueOnce({ ruleId: null, skipped: [] });
    fireEvent.click(screen.getByText('Check'));
    fireEvent.click(screen.getByText('Check'));
    await screen.findByText('No rule matches. Zana would leave the agent waiting for you.');
    first({ ruleId: 'a', message: 'continue', delaySeconds: 20, skipped: [] });
    await Promise.resolve();
    expect(screen.queryByText(/Matches rule/)).toBeNull();
  });

  it('Check says it is desktop-only when the API is missing', async () => {
    delete (window as any).cc;
    setup(on());
    fireEvent.click(screen.getByText('Check'));
    await waitFor(() => expect(screen.getByText('Check is only available in the desktop app.')).toBeTruthy());
  });
});
