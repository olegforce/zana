import { useState } from 'react';
import type { AppConfig } from '@zana-ai/zcc-domain/product';
import {
  API_ERROR_RESUME_DEFAULTS,
  API_ERROR_RESUME_SUGGESTIONS,
  isValidResumePattern,
  type ApiErrorResumeConfig,
  type ApiErrorResumeRule
} from '@zana-ai/zcc-domain/product';
import { CheckboxField, Section } from '@/components/settings/FormFields';
import './api-error-resume.css';

const EMPTY: ApiErrorResumeConfig = { enabled: false, rules: [], maxPerWindow: 3, windowMinutes: 15 };
const D = API_ERROR_RESUME_DEFAULTS;

type CheckResult =
  | { kind: 'unavailable' }
  | { kind: 'match'; n: number; message: string; delaySeconds: number }
  | { kind: 'none' }
  | { kind: 'skipped'; ns: number[] };

let ruleSeq = 0;
const newId = () => `r${Date.now().toString(36)}${(ruleSeq++).toString(36)}`;

function ruleError(rule: ApiErrorResumeRule): string | null {
  const match = rule.match.trim();
  if (match.length < D.minMatchChars) return 'At least 4 characters';
  if (rule.matchMode === 'regex' && !isValidResumePattern(match)) return 'Not a valid regular expression';
  return null;
}

const clamp = (n: number, min: number, max: number, fallback: number) =>
  Math.max(min, Math.min(max, Number.isNaN(n) ? fallback : n));

export function ApiErrorResumeSection({
  config,
  onUpdate,
  onConfigDraft
}: {
  config: AppConfig;
  onUpdate: (patch: Partial<AppConfig>) => Promise<void> | void;
  onConfigDraft: (next: AppConfig) => void;
}) {
  const current = config.apiErrorResume ?? EMPTY;
  const [checkText, setCheckText] = useState('');
  const [result, setResult] = useState<CheckResult | null>(null);

  const sendable = (rules: ApiErrorResumeRule[]) => rules.filter((r) => !ruleError(r));
  const draft = (patch: Partial<ApiErrorResumeConfig>) =>
    onConfigDraft({ ...config, apiErrorResume: { ...current, ...patch } });
  // Always a whole object; rows that would be rejected are never persisted.
  const save = (patch: Partial<ApiErrorResumeConfig>) => {
    const next = { ...current, ...patch };
    return onUpdate({ apiErrorResume: { ...next, rules: sendable(next.rules) } });
  };
  const editRule = (index: number, patch: Partial<ApiErrorResumeRule>) =>
    draft({ rules: current.rules.map((r, i) => (i === index ? { ...r, ...patch } : r)) });
  const commit = (rules: ApiErrorResumeRule[], index: number) => {
    if (!ruleError(rules[index])) void save({ rules });
  };
  const addRule = (partial: Partial<ApiErrorResumeRule> = {}) => {
    const rule: ApiErrorResumeRule = {
      id: newId(), match: '', matchMode: 'contains', message: D.message,
      delaySeconds: D.delaySeconds, enabled: true, ...partial
    };
    if (partial.match) void save({ rules: [...current.rules, rule] });
    else draft({ rules: [...current.rules, rule] });
  };
  const removeRule = (index: number) => void save({ rules: current.rules.filter((_, i) => i !== index) });

  const runCheck = async () => {
    const api = (window as unknown as { cc?: { apiErrorResume?: { check: (i: { text: string; rules: unknown }) => Promise<any> } } }).cc?.apiErrorResume;
    if (!api) return setResult({ kind: 'unavailable' });
    const rules = sendable(current.rules);
    const res = await api.check({ text: checkText, rules });
    const indexOf = (id: string) => rules.findIndex((r) => r.id === id) + 1;
    if (res.ruleId) {
      return setResult({ kind: 'match', n: indexOf(res.ruleId), message: res.message ?? D.message, delaySeconds: res.delaySeconds ?? D.delaySeconds });
    }
    const slow = (res.skipped ?? []).filter((s: { reason: string }) => s.reason === 'timeout');
    setResult(slow.length ? { kind: 'skipped', ns: slow.map((s: { ruleId: string }) => indexOf(s.ruleId)) } : { kind: 'none' });
  };

  return (
    <Section
      anchorId="api-error-resume"
      searchId="agents.api-error-resume.intro"
      title="Resume after API errors"
      help="When an agent's turn stops on an API error that matches a rule below, Zana sends it a message so it carries on. Off by default. Works with Claude Code sessions: CLI Agent tabs, Squad engineers and scheduled runs."
    >
      <CheckboxField
        label="Resume after matching API errors"
        searchId="agents.api-error-resume"
        checked={current.enabled}
        onChange={(enabled) => void save({ enabled })}
      />
      {current.enabled && (
        <>
          <div className="api-error-resume-rules" data-settings-target="agents.api-error-resume-rules">
            <ul className="team-slot-list api-error-resume-list">
              {current.rules.map((rule, i) => {
                const error = ruleError(rule);
                return (
                  <li key={rule.id} className="api-error-resume-row">
                    <label className="api-error-resume-match">
                      When the error matches
                      <input
                        type="text"
                        aria-label={`When the error matches (rule ${i + 1})`}
                        value={rule.match}
                        onChange={(e) => editRule(i, { match: e.target.value })}
                        onBlur={() => commit(current.rules, i)}
                      />
                    </label>
                    <label className="api-error-resume-regex">
                      <input
                        type="checkbox"
                        aria-label={`Regex (rule ${i + 1})`}
                        checked={rule.matchMode === 'regex'}
                        onChange={(e) => {
                          const rules = current.rules.map((r, j) => (j === i ? { ...r, matchMode: e.target.checked ? 'regex' as const : 'contains' as const } : r));
                          draft({ rules });
                          commit(rules, i);
                        }}
                      />
                      Regex
                    </label>
                    <label>
                      Send
                      <input
                        type="text"
                        aria-label={`Send (rule ${i + 1})`}
                        value={rule.message}
                        onChange={(e) => editRule(i, { message: e.target.value })}
                        onBlur={() => commit(current.rules, i)}
                      />
                    </label>
                    <label>
                      After (seconds)
                      <input
                        type="number"
                        min={D.minDelaySeconds}
                        max={D.maxDelaySeconds}
                        aria-label={`After (seconds) (rule ${i + 1})`}
                        value={rule.delaySeconds}
                        onChange={(e) => {
                          const n = parseInt(e.target.value, 10);
                          if (!Number.isNaN(n)) editRule(i, { delaySeconds: n });
                        }}
                        onBlur={(e) => {
                          const n = clamp(parseInt(e.target.value, 10), D.minDelaySeconds, D.maxDelaySeconds, D.delaySeconds);
                          const rules = current.rules.map((r, j) => (j === i ? { ...r, delaySeconds: n } : r));
                          draft({ rules });
                          commit(rules, i);
                        }}
                      />
                    </label>
                    <button type="button" className="settings-btn" aria-label={`Remove rule ${i + 1}`} onClick={() => removeRule(i)}>
                      Remove
                    </button>
                    {error && <p className="api-error-resume-error" role="alert">{error}</p>}
                  </li>
                );
              })}
            </ul>
            <div className="api-error-resume-actions">
              <button type="button" className="settings-btn" onClick={() => addRule()}>Add rule</button>
              {API_ERROR_RESUME_SUGGESTIONS.filter(
                (s) => !current.rules.some((r) => r.match.toLowerCase() === s.match!.toLowerCase())
              ).map((s) => (
                <button key={s.match} type="button" className="settings-btn" onClick={() => addRule(s)}>
                  + {s.match}
                </button>
              ))}
            </div>
            <p className="settings-help">Zana only sends the message if you haven't typed in that agent since the error.</p>
            <p className="settings-help">Only add errors that clear up by themselves. Sign-in, billing and “request too large” errors fail again if the agent just carries on.</p>
          </div>

          <div className="api-error-resume-cap" data-settings-target="agents.api-error-resume-cap">
            <div className="api-error-resume-cap-line">
              Stop after
              <input
                type="number" min={1} max={10} aria-label="Messages before stopping"
                value={current.maxPerWindow}
                onChange={(e) => { const n = parseInt(e.target.value, 10); if (!Number.isNaN(n)) draft({ maxPerWindow: n }); }}
                onBlur={(e) => void save({ maxPerWindow: clamp(parseInt(e.target.value, 10), 1, 10, D.maxPerWindow) })}
              />
              messages in
              <input
                type="number" min={5} max={120} aria-label="Minutes in the window"
                value={current.windowMinutes}
                onChange={(e) => { const n = parseInt(e.target.value, 10); if (!Number.isNaN(n)) draft({ windowMinutes: n }); }}
                onBlur={(e) => void save({ windowMinutes: clamp(parseInt(e.target.value, 10), 5, 120, D.windowMinutes) })}
              />
              minutes for one agent, then mark it as needing you.
            </div>
          </div>

          <div className="api-error-resume-check" data-settings-target="agents.api-error-resume-check">
            <label>
              Check an error
              <textarea
                aria-label="Error text to check"
                value={checkText}
                onChange={(e) => setCheckText(e.target.value)}
              />
            </label>
            <div className="api-error-resume-actions">
              <button type="button" className="settings-btn" onClick={() => void runCheck()}>Check</button>
            </div>
            {result && (
              <p className="settings-help" role="status">
                {result.kind === 'unavailable' && 'Check is only available in the desktop app.'}
                {result.kind === 'match' && `Matches rule ${result.n}: Zana would send “${result.message}” after ${result.delaySeconds} s.`}
                {result.kind === 'none' && 'No rule matches. Zana would leave the agent waiting for you.'}
                {result.kind === 'skipped' && result.ns.map((n) => `Rule ${n} took too long to check and was skipped.`).join(' ')}
              </p>
            )}
          </div>
        </>
      )}
    </Section>
  );
}
