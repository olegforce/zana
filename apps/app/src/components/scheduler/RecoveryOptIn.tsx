import { useEffect, useMemo, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { product } from '../../lib/product-client.js';
import type { ScheduleCatchUp, ScheduledTask, ScheduleRetryPolicy } from '@zana-ai/zcc-domain/product';
import { isRecoveryMode } from '@zana-ai/zcc-domain/schedule-health';
import { Modal } from '../Modal.js';
import './scheduler-problems.css';

/** Native schedules still on the classic timing rules. */
export const classicSchedules = (tasks: readonly ScheduledTask[]): ScheduledTask[] =>
  tasks.filter((t) => !t.external && !isRecoveryMode(t));

/**
 * One-time offer to turn on missed/failed run recovery. Starts hidden and shows
 * only once the config confirms it was neither dismissed nor applied, so it never flashes.
 */
export function RecoveryCard({ tasks, onReview, refreshKey }: { tasks: readonly ScheduledTask[]; onReview: () => void; refreshKey?: unknown }) {
  const [unanswered, setUnanswered] = useState(false);

  useEffect(() => {
    product.config
      .get()
      .then((c) => setUnanswered(!c.schedulerRecoveryIntro))
      .catch(() => {});
  }, [refreshKey]);

  if (!unanswered || classicSchedules(tasks).length === 0) return null;

  const notNow = () => {
    setUnanswered(false);
    product.config.set({ schedulerRecoveryIntro: 'dismissed' }).catch(() => {});
  };

  return (
    <section className="recovery-card" role="region" aria-label="Run recovery">
      <RotateCcw size={16} aria-hidden />
      <div className="recovery-card-text">
        <strong>New: missed and failed run recovery.</strong>
        <span>
          Your schedules still run exactly as before. Turn on recovery to catch up missed runs, queue runs over the limit, and optionally retry temporary failures.
        </span>
      </div>
      <div className="recovery-card-actions">
        <button type="button" className="settings-btn settings-btn--primary" onClick={onReview}>Review</button>
        <button type="button" className="settings-btn" onClick={notNow}>Not now</button>
      </div>
    </section>
  );
}

type MissedChoice = 'once' | 'skip' | 'all';

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, Number.isFinite(n) ? Math.round(n) : min));

export function RecoveryDialog({ tasks, onClose }: { tasks: readonly ScheduledTask[]; onClose: () => void }) {
  const classic = useMemo(() => classicSchedules(tasks), [tasks]);
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set(classic.map((t) => t.id)));
  const [missed, setMissed] = useState<MissedChoice>('once');
  const [missedMax, setMissedMax] = useState(3);
  const [retryOn, setRetryOn] = useState(false);
  const [attempts, setAttempts] = useState(1);
  const [delay, setDelay] = useState(10);
  const [applying, setApplying] = useState(false);
  const [outcome, setOutcome] = useState<{ done: number; failed: string[] } | null>(null);

  const targets = classic.filter((t) => checked.has(t.id));
  const toggle = (id: string) => {
    const next = new Set(checked);
    if (!next.delete(id)) next.add(id);
    setChecked(next);
  };

  const apply = async () => {
    if (targets.length === 0 || applying) return;
    setApplying(true);
    const catchUp: ScheduleCatchUp = missed === 'all' ? { mode: 'all', max: clamp(missedMax, 1, 10) } : { mode: missed };
    const retry: ScheduleRetryPolicy | null = retryOn
      ? { attempts: clamp(attempts, 1, 5), delayMinutes: clamp(delay, 1, 1440) }
      : null;
    let done = 0;
    const failed: string[] = [];
    for (const task of targets) {
      try {
        const result = await product.scheduler.update(task.id, { catchUp, ...(retry ? { retry } : {}) });
        if (result.ok) done++;
        else failed.push(task.name);
      } catch {
        failed.push(task.name);
      }
    }
    if (done > 0) await product.config.set({ schedulerRecoveryIntro: 'applied' }).catch(() => {});
    setOutcome({ done, failed });
    setApplying(false);
  };

  return (
    <Modal
      title="Turn on recovery"
      onClose={onClose}
      className="recovery-dialog"
      footer={
        outcome ? (
          <button type="button" className="btn primary" onClick={onClose} autoFocus>Done</button>
        ) : (
          <>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="button" className="btn primary" disabled={targets.length === 0 || applying} onClick={() => void apply()}>
              {applying ? 'Turning on…' : `Turn on for ${targets.length} ${targets.length === 1 ? 'schedule' : 'schedules'}`}
            </button>
          </>
        )
      }
    >
      {outcome ? (
        <div role="status" className="recovery-dialog-result">
          <p>{outcome.done} turned on</p>
          {outcome.failed.length > 0 && <p className="modal-error">Could not update: {outcome.failed.join(', ')}</p>}
        </div>
      ) : (
        <div className="recovery-dialog-body">
          <fieldset>
            <legend>Schedules</legend>
            {classic.length === 0 ? (
              <p className="modal-hint">Every schedule already has recovery turned on.</p>
            ) : classic.map((t) => (
              <label key={t.id} className="scheduler-checkbox-row">
                <input type="checkbox" checked={checked.has(t.id)} onChange={() => toggle(t.id)} />
                <span>{t.name}</span>
              </label>
            ))}
          </fieldset>
          <div className="scheduler-form-field">
            <label htmlFor="recovery-missed">Missed runs</label>
            <select id="recovery-missed" value={missed} onChange={(e) => setMissed(e.target.value as MissedChoice)}>
              <option value="once">Run once (recommended)</option>
              <option value="skip">Skip</option>
              <option value="all">Run each missed time, up to N</option>
            </select>
            {missed === 'all' && (
              <div className="recovery-inline">
                <label htmlFor="recovery-missed-max">Up to</label>
                <input id="recovery-missed-max" type="number" min={1} max={10} value={missedMax}
                  onChange={(e) => setMissedMax(clamp(parseInt(e.target.value, 10), 1, 10))} />
                <span>missed times</span>
              </div>
            )}
          </div>
          <div className="scheduler-form-field">
            <label className="scheduler-checkbox-row">
              <input type="checkbox" checked={retryOn} onChange={(e) => setRetryOn(e.target.checked)} />
              <span>Auto-retry temporary failures</span>
            </label>
            {retryOn && (
              <div className="recovery-inline">
                <label htmlFor="recovery-attempts">Up to</label>
                <input id="recovery-attempts" type="number" min={1} max={5} value={attempts}
                  onChange={(e) => setAttempts(clamp(parseInt(e.target.value, 10), 1, 5))} />
                <span>times, wait</span>
                <label htmlFor="recovery-delay" className="sr-only">Wait minutes</label>
                <input id="recovery-delay" type="number" min={1} max={1440} value={delay}
                  onChange={(e) => setDelay(clamp(parseInt(e.target.value, 10), 1, 1440))} />
                <span>minutes</span>
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
