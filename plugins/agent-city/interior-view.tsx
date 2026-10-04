import { harnessStyle } from './commuters.js';
import { nextRunLabel, STATUS_LABELS } from './model.js';
import type { InteriorModel } from './interior.js';

export function InteriorDetails({ model, onInspect }: { model: InteriorModel; onInspect: (key: string) => void }) {
  return <div className="city-interior-details">
    {model.workers.length > 0 && <div className="city-workstations" role="group" aria-label="Agents on this floor">
      {model.workers.map(({ occupant, color, atDesk, slot, highlighted }) => {
        const item = occupant.item, label = occupant.kind === 'plan' ? 'Scheduled plan' : STATUS_LABELS[occupant.item.status];
        return <button className="city-workstation" type="button" key={item.key} data-highlighted={highlighted} title={`${item.title} · ${label}`} data-status={occupant.kind === 'agent' ? occupant.item.status : 'planned'} data-location={atDesk ? 'desk' : 'relaxing'}
        aria-label={`Worker ${item.title}, ${label}`} onClick={() => onInspect(item.key)}>
        <span className="city-desk-number" style={{ background: color }} aria-hidden="true">{slot + 1}</span>
        <span><strong>{item.title}</strong><small><i className="city-dot" aria-hidden="true"/>{label} · {harnessStyle(item.harness).name}</small><small>{occupant.kind === 'plan' ? !occupant.item.enabled ? 'Paused · at a desk' : 'At a desk · waiting for its next run' : atDesk ? `At a desk${occupant.item.scheduled ? ' · Scheduled' : ''}` : 'Relaxing or taking a stroll'}</small></span>
        <span aria-hidden="true">{occupant.kind === 'agent' && occupant.item.status === 'needs-you' ? '!' : '↗'}</span>
      </button>; })}
    </div>}
    {model.floor.kind === 'lobby' && <p className="city-interior-note">Welcome in. Take the elevator to a floor to visit your agents.</p>}
    {model.floor.kind === 'terrace' && <p className="city-interior-note">A little breathing room above the city. Agent workstations are on the office floors.</p>}
    {model.floor.kind === 'work' && model.workers.length === 0 && <p className="city-interior-note">{model.building.schedules.length ? 'Ready for scheduled work. Plans below show when work is expected.' : 'A quiet floor. Find current and exited sessions in the roster.'}</p>}
    {model.building.schedules.length > 0 && <details className="city-plan-board" open={model.building.count === 0}>
      <summary>Schedule board · {model.building.schedules.length} plans</summary>
      {model.building.schedules.map((s) => <button type="button" className="city-plan" key={s.key} onClick={() => onInspect(s.key)} aria-label={`Schedule board: ${s.title}`}>
        <strong>{s.title}</strong><span>{s.running ? 'Running' : !s.enabled ? 'Paused' : nextRunLabel(s.nextRunAt)}</span>
      </button>)}
    </details>}
  </div>;
}
