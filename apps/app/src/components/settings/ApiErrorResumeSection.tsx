import { useRef, useState } from 'react';
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

const D = API_ERROR_RESUME_DEFAULTS;
const EMPTY: ApiErrorResumeConfig = { enabled: false, rules: [], maxPerWindow: D.maxPerWindow, windowMinutes: D.windowMinutes };

type CheckResult =
  | { kind: 'unavailable' }
  | { kind: 'match'; n: number; message: string; delaySeconds: number }
  | { kind: 'none' }
  | { kind: 'skipped'; lines: string[] };

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
  // Rows never saved yet live here, so a save elsewhere can't wipe a half-filled row.
  const [pending, setPending] = useState<ApiErrorResumeRule[]>([]);
  // The last valid version of each stored rule: a rule mid-edit keeps it when other fields save.
  const lastValid = useRef(new Map<string, ApiErrorResumeRule>());
  const checkSeq = useRef(0);
  for (const r of current.rules) if (!ruleError(r)) lastValid.current.set(r.id, r);
  const rows = [...current.rules, ...pending];

  const sendable = (rules: ApiErrorResumeRule[]) =>
    rules.flatMap((r) => (!ruleError(r) ? [r] : lastValid.current.get(r.id) ? [lastValid.current.get(r.id)!] : []));
  const draft = (patch: Partial<ApiErrorResumeConfig>) =>
    onConfigDraft({ ...config, apiErrorResume: { ...current, ...patch } });
  // Always a whole object; a rule that is invalid right now keeps its last saved version.
  const save = (patch: Partial<ApiErrorResumeConfig>) => {
    const next = { ...current, ...patch };
    return onUpdate({ apiErrorResume: { ...next, rules: sendable(next.rules) } });
  };
  const apply = (id: string, patch: Partial<ApiErrorResumeRule>, commit: boolean) => {
    const row = rows.find((r) => r.id === id);
    if (!row) return;
    const updated = { ...row, ...patch };
    if (pending.some((r) => r.id === id)) {
      if (commit && !ruleError(updated)) {
        setPending(pending.filter((r) => r.id !== id));
        void save({ rules: [...current.rules, updated] });
      } else setPending(pending.map((r) => (r.id === id ? updated : r)));
      return;
    }
    const rules = current.rules.map((r) => (r.id === id ? updated : r));
    draft({ rules });
    if (commit && !ruleError(updated)) void save({ rules });
  };
  const addRule = (partial: Partial<ApiErrorResumeRule> = {}) => {
    const rule: ApiErrorResumeRule = {
      id: newId(), match: '', matchMode: 'contains', message: D.message,
      delaySeconds: D.delaySeconds, enabled: true, ...partial
    };
    if (partial.match) void save({ rules: [...current.rules, rule] });
    else setPending([...pending, rule]);
  };
  const removeRule = (id: string) => {
    if (pending.some((r) => r.id === id)) setPending(pending.filter((r) => r.id !== id));
    else void save({ rules: current.rules.filter((r) => r.id !== id) });
  };

  const runCheck = async () => {
    const api = (window as unknown as { cc?: { apiErrorResume?: { check: (i: { text: string; rules: unknown }) => Promise<any> } } }).cc?.apiErrorResume;
    if (!api) return setResult({ kind: 'unavailable' });
    const seq = ++checkSeq.current;
    const res = await api.check({ text: checkText, rules: sendable(current.rules) });
    if (seq !== checkSeq.current) return; // a newer Check is in flight
    const indexOf = (id: string) => rows.findIndex((r) => r.id === id) + 1;
    if (res.ruleId) {
      return setResult({ kind: 'match', n: indexOf(res.ruleId), message: res.message ?? D.message, delaySeconds: res.delaySeconds ?? D.delaySeconds });
    }
    const lines = (res.skipped ?? []).map((s: { ruleId: string; reason: string }) =>
      s.reason === 'timeout'
        ? `Rule ${indexOf(s.ruleId)} took too long to check and was skipped.`
        : `Rule ${indexOf(s.ruleId)} could not be checked right now. Try again.`);
    setResult(lines.length ? { kind: 'skipped', lines } : { kind: 'none' });
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
              {rows.map((rule, i) => {
                const error = ruleError(rule);
                return (
                  <li key={rule.id} className="api-error-resume-row">
                    <label className="api-error-resume-match">
                      When the error matches
                      <input
                        type="text"
                        aria-label={`When the error matches (rule ${i + 1})`}
                        value={rule.match}
                        onChange={(e) => apply(rule.id, { match: e.target.value }, false)}
                        onBlur={() => apply(rule.id, {}, true)}
                      />
                    </label>
                    <label className="api-error-resume-regex">
                      <input
                        type="checkbox"
                        aria-label={`Regex (rule ${i + 1})`}
                        checked={rule.matchMode === 'regex'}
                        onChange={(e) => apply(rule.id, { matchMode: e.target.checked ? 'regex' : 'contains' }, true)}
                      />
                      Regex
                    </label>
                    <label>
                      Send
                      <input
                        type="text"
                        aria-label={`Send (rule ${i + 1})`}
                        value={rule.message}
                        onChange={(e) => apply(rule.id, { message: e.target.value }, false)}
                        onBlur={() => apply(rule.id, {}, true)}
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
                          if (!Number.isNaN(n)) apply(rule.id, { delaySeconds: n }, false);
                        }}
                        onBlur={(e) =>
                          apply(rule.id, { delaySeconds: clamp(parseInt(e.target.value, 10), D.minDelaySeconds, D.maxDelaySeconds, D.delaySeconds) }, true)
                        }
                      />
                    </label>
                    <button type="button" className="settings-btn" aria-label={`Remove rule ${i + 1}`} onClick={() => removeRule(rule.id)}>
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
                (s) => !rows.some((r) => r.match.toLowerCase() === s.match!.toLowerCase())
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
                type="number" min={D.minPerWindow} max={D.maxPerWindowLimit} aria-label="Messages before stopping"
                value={current.maxPerWindow}
                onChange={(e) => { const n = parseInt(e.target.value, 10); if (!Number.isNaN(n)) draft({ maxPerWindow: n }); }}
                onBlur={(e) => void save({ maxPerWindow: clamp(parseInt(e.target.value, 10), D.minPerWindow, D.maxPerWindowLimit, D.maxPerWindow) })}
              />
              messages in
              <input
                type="number" min={D.minWindowMinutes} max={D.maxWindowMinutes} aria-label="Minutes in the window"
                value={current.windowMinutes}
                onChange={(e) => { const n = parseInt(e.target.value, 10); if (!Number.isNaN(n)) draft({ windowMinutes: n }); }}
                onBlur={(e) => void save({ windowMinutes: clamp(parseInt(e.target.value, 10), D.minWindowMinutes, D.maxWindowMinutes, D.windowMinutes) })}
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
                {result.kind === 'skipped' && result.lines.join(' ')}
              </p>
            )}
          </div>
        </>
      )}
    </Section>
  );
}
