import { useEffect, useRef, useState } from 'react';
import type { AppConfig } from '@zana-ai/zcc-domain/product';
import {
  API_ERROR_RESUME_DEFAULTS,
  API_ERROR_RESUME_SUGGESTIONS,
  apiErrorResumeRuleKey,
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
  | { kind: 'failed' }
  | { kind: 'match'; n: number; message: string; delaySeconds: number }
  | { kind: 'none' }
  | { kind: 'skipped'; lines: string[] };

/** Resolves true once stored; never rejects (a failure shows the save alert instead). */
type Save = (patch: Partial<ApiErrorResumeConfig>) => Promise<boolean>;
type Apply = (id: string, patch: Partial<ApiErrorResumeRule>, commit: boolean) => void;

let ruleSeq = 0;
const newId = () => `r${Date.now().toString(36)}${(ruleSeq++).toString(36)}`;

/** Mirrors `normalizeApiErrorResume`, so a row it would drop shows why instead of vanishing on save. */
function ruleError(rule: ApiErrorResumeRule, rows: ApiErrorResumeRule[]): string | null {
  const match = rule.match.trim();
  if (match.length < D.minMatchChars) return `At least ${D.minMatchChars} characters`;
  if (match.length > D.maxMatchChars) return `At most ${D.maxMatchChars} characters`;
  if (rule.matchMode === 'regex' && !isValidResumePattern(match)) return 'Not a valid regular expression';
  const key = apiErrorResumeRuleKey(rule);
  const twin = rows.findIndex((r) => r.id !== rule.id && apiErrorResumeRuleKey(r) === key);
  if (twin >= 0) return `Same as rule ${twin + 1}`;
  return null;
}

const clamp = (n: number, min: number, max: number, fallback: number) =>
  Math.max(min, Math.min(max, Number.isNaN(n) ? fallback : n));

/**
 * The rule rows: stored rules (with local edits) followed by drafts not yet
 * stored. A draft or edit is only dropped once its save succeeds, so a failed
 * save keeps what the user typed.
 */
function useResumeRules(current: ApiErrorResumeConfig, save: Save) {
  // Rows never saved yet live here, so a save elsewhere can't wipe a half-filled row.
  const [pending, setPending] = useState<ApiErrorResumeRule[]>([]);
  // Edits to stored rules stay local until a valid commit, so `current.rules` is always
  // what is stored and an unrelated save can never persist (or drop) a half-typed rule.
  const [edits, setEdits] = useState<Record<string, ApiErrorResumeRule>>({});
  const stored = new Set(current.rules.map((r) => r.id));
  const rows = [...current.rules.map((r) => edits[r.id] ?? r), ...pending.filter((r) => !stored.has(r.id))];

  // A draft leaves `pending` once the stored config has it.
  useEffect(() => {
    const ids = new Set(current.rules.map((r) => r.id));
    setPending((prev) => (prev.some((r) => ids.has(r.id)) ? prev.filter((r) => !ids.has(r.id)) : prev));
  }, [current.rules]);

  const dropEdit = (id: string, only?: ApiErrorResumeRule) =>
    setEdits((prev) => {
      if (!(id in prev) || (only && prev[id] !== only)) return prev; // a newer edit stays
      const { [id]: _done, ...rest } = prev;
      return rest;
    });

  const apply: Apply = (id, patch, commit) => {
    const row = rows.find((r) => r.id === id);
    if (!row) return;
    const updated = { ...row, ...patch };
    const valid = commit && !ruleError(updated, rows);
    if (!stored.has(id)) {
      setPending((prev) => prev.map((r) => (r.id === id ? updated : r)));
      if (valid) void save({ rules: [...current.rules, updated] });
      return;
    }
    setEdits((prev) => ({ ...prev, [id]: updated }));
    if (valid) {
      void save({ rules: current.rules.map((r) => (r.id === id ? updated : r)) }).then((ok) => {
        if (ok) dropEdit(id, updated);
      });
    }
  };
  const addRule = (partial: Partial<ApiErrorResumeRule> = {}) => {
    const rule: ApiErrorResumeRule = {
      id: newId(), match: '', matchMode: 'contains', message: D.message,
      delaySeconds: D.delaySeconds, enabled: true, ...partial
    };
    if (partial.match) void save({ rules: [...current.rules, rule] });
    else setPending((prev) => [...prev, rule]);
  };
  const removeRule = (id: string) => {
    if (!stored.has(id)) return setPending((prev) => prev.filter((r) => r.id !== id));
    void save({ rules: current.rules.filter((r) => r.id !== id) }).then((ok) => {
      if (ok) dropEdit(id);
    });
  };
  return { rows, apply, addRule, removeRule };
}

function RuleRow({ rule, n, error, apply, onRemove }: {
  rule: ApiErrorResumeRule;
  n: number;
  error: string | null;
  apply: Apply;
  onRemove: () => void;
}) {
  return (
    <li className="api-error-resume-row">
      <label className="api-error-resume-match">
        When the error matches
        <input
          type="text"
          aria-label={`When the error matches (rule ${n})`}
          value={rule.match}
          onChange={(e) => apply(rule.id, { match: e.target.value }, false)}
          onBlur={() => apply(rule.id, {}, true)}
        />
      </label>
      <label className="api-error-resume-regex">
        <input
          type="checkbox"
          aria-label={`Regex (rule ${n})`}
          checked={rule.matchMode === 'regex'}
          onChange={(e) => apply(rule.id, { matchMode: e.target.checked ? 'regex' : 'contains' }, true)}
        />
        Regex
      </label>
      <label>
        Send
        <input
          type="text"
          maxLength={D.maxMessageChars}
          aria-label={`Send (rule ${n})`}
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
          aria-label={`After (seconds) (rule ${n})`}
          value={rule.delaySeconds}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            if (!Number.isNaN(v)) apply(rule.id, { delaySeconds: v }, false);
          }}
          onBlur={(e) =>
            apply(rule.id, { delaySeconds: clamp(parseInt(e.target.value, 10), D.minDelaySeconds, D.maxDelaySeconds, D.delaySeconds) }, true)
          }
        />
      </label>
      <button type="button" className="settings-btn" aria-label={`Remove rule ${n}`} onClick={onRemove}>
        Remove
      </button>
      {error && <p className="api-error-resume-error" role="alert">{error}</p>}
    </li>
  );
}

function RuleList({ rows, apply, addRule, removeRule }: ReturnType<typeof useResumeRules>) {
  // The normaliser keeps only the first `maxRules`, so stop adding at the limit.
  const full = rows.length >= D.maxRules;
  const suggestions = API_ERROR_RESUME_SUGGESTIONS.filter(
    (s) => !rows.some((r) => r.match.toLowerCase() === s.match!.toLowerCase())
  );
  return (
    <div className="api-error-resume-rules" data-settings-target="agents.api-error-resume-rules">
      <ul className="team-slot-list api-error-resume-list">
        {rows.map((rule, i) => (
          <RuleRow key={rule.id} rule={rule} n={i + 1} error={ruleError(rule, rows)} apply={apply} onRemove={() => removeRule(rule.id)} />
        ))}
      </ul>
      <div className="api-error-resume-actions">
        <button type="button" className="settings-btn" disabled={full} onClick={() => addRule()}>Add rule</button>
        {suggestions.map((s) => (
          <button key={s.match} type="button" className="settings-btn" disabled={full} onClick={() => addRule(s)}>
            + {s.match}
          </button>
        ))}
      </div>
      {full && <p className="settings-help">You can have up to {D.maxRules} rules.</p>}
      <p className="settings-help">Zana only sends the message if you haven't typed in that agent since the error.</p>
      <p className="settings-help">Only add errors that clear up by themselves. Sign-in, billing and “request too large” errors fail again if the agent just carries on.</p>
    </div>
  );
}

function CapControls({ current, draft, save }: {
  current: ApiErrorResumeConfig;
  draft: (patch: Partial<ApiErrorResumeConfig>) => void;
  save: Save;
}) {
  return (
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
  );
}

type CheckApi = { check: (i: { text: string; rules: unknown }) => Promise<any> };

function describeCheck(res: any, rows: ApiErrorResumeRule[]): CheckResult {
  const indexOf = (id: string) => rows.findIndex((r) => r.id === id) + 1;
  if (res.ruleId) {
    return { kind: 'match', n: indexOf(res.ruleId), message: res.message ?? D.message, delaySeconds: res.delaySeconds ?? D.delaySeconds };
  }
  const lines = (res.skipped ?? []).map((s: { ruleId: string; reason: string }) =>
    s.reason === 'timeout'
      ? `Rule ${indexOf(s.ruleId)} took too long to check and was skipped.`
      : `Rule ${indexOf(s.ruleId)} could not be checked right now. Try again.`);
  return lines.length ? { kind: 'skipped', lines } : { kind: 'none' };
}

function ErrorCheck({ rows }: { rows: ApiErrorResumeRule[] }) {
  const [checkText, setCheckText] = useState('');
  const [result, setResult] = useState<CheckResult | null>(null);
  const checkSeq = useRef(0);

  const runCheck = async () => {
    const api = (window as unknown as { cc?: { apiErrorResume?: CheckApi } }).cc?.apiErrorResume;
    if (!api) return setResult({ kind: 'unavailable' });
    const seq = ++checkSeq.current;
    let next: CheckResult;
    try {
      next = describeCheck(await api.check({ text: checkText, rules: rows.filter((r) => !ruleError(r, rows)) }), rows);
    } catch {
      next = { kind: 'failed' };
    }
    if (seq === checkSeq.current) setResult(next); // else a newer Check is in flight
  };

  return (
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
          {result.kind === 'failed' && "Zana couldn't check the error just now. Try again."}
          {result.kind === 'match' && `Matches rule ${result.n}: Zana would send “${result.message}” after ${result.delaySeconds} s.`}
          {result.kind === 'none' && 'No rule matches. Zana would leave the agent waiting for you.'}
          {result.kind === 'skipped' && result.lines.join(' ')}
        </p>
      )}
    </div>
  );
}

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
  const [saveFailed, setSaveFailed] = useState(false);
  const draft = (patch: Partial<ApiErrorResumeConfig>) =>
    onConfigDraft({ ...config, apiErrorResume: { ...current, ...patch } });
  // Always a whole object.
  const save: Save = async (patch) => {
    try {
      await onUpdate({ apiErrorResume: { ...current, ...patch } });
      setSaveFailed(false);
      return true;
    } catch {
      setSaveFailed(true);
      return false;
    }
  };
  const rules = useResumeRules(current, save);

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
      {saveFailed && (
        <p className="api-error-resume-error" role="alert">Couldn't save the last change. What you typed is still here, so try again.</p>
      )}
      {current.enabled && (
        <>
          <RuleList {...rules} />
          <CapControls current={current} draft={draft} save={save} />
          <ErrorCheck rows={rules.rows} />
        </>
      )}
    </Section>
  );
}
