import { useMemo, useRef, useState } from 'react';
import { definePluginApp, type PluginAgentsViewProps } from '@zana-ai/zcc-plugin-sdk/app';
import { projectCity, cityBuildings, cityLayout, reconcileLots, labelPosition, STATUS_LABELS, nextRunLabel, type StatusFilter } from './model.js';
import { cityStyles } from './styles.js';
import { useCityCanvas } from './use-city.js';
import { useCityCamera } from './use-camera.js';
const PAGE_SIZE = 40;
export function AgentCity(props: PluginAgentsViewProps) {
  const root = useRef<HTMLElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const projects = useMemo(() => projectCity(props), [props.projects, props.members, props.schedules, props.executions, props.searchQuery]);
  const [selected, setSelected] = useState('all'), [filter, setFilter] = useState<StatusFilter>('all');
  const [inspecting, setInspecting] = useState(false);
  const lotAssignments = useRef(new Map<string, number>());
  lotAssignments.current = reconcileLots(lotAssignments.current, props.projects);
  const buildings = cityBuildings(projects, lotAssignments.current);
  const { camera, dragging, zoomBy, fit, handlers } = useCityCamera();
  const [paused, setPaused] = useState(false), [search, setSearch] = useState(''), [pageChoice, setPage] = useState(0);
  const place = selected === 'all' || selected === 'station' || selected === 'library' || selected === 'attention' ? selected
    : projects.some((p) => p.id === selected) ? selected : 'all';
  const project = projects.find((p) => p.id === place);
  function select(key: string) {
    if (key === 'all' || key === 'station' || key === 'library' || key === 'attention' || projects.some((p) => p.id === key)) {
      setSelected(key);
      setInspecting(true);
      setFilter('all');
      setSearch('');
      setPage(0);
    }
    else
      props.onInspect(key);
  }
  const { available, reduced, viewport } = useCityCanvas(root, canvas, buildings, place, paused, select);
  const layout = cityLayout(buildings, viewport.width, viewport.height);
  const counts = useMemo(() => props.members.reduce((acc, m) => ({ ...acc, [m.status]: acc[m.status] + 1 }), { working: 0, 'needs-you': 0, idle: 0, done: 0, error: 0, unknown: 0 }), [props.members]);
  const attention = counts['needs-you'] + props.executions.filter((e) => e.needsAttention).length;
  const members = (place === 'library' ? props.members.filter((m) => !m.live)
    : place === 'attention' ? props.members.filter((m) => m.status === 'needs-you')
      : project?.members ?? props.members).filter((m) => (filter === 'all' || m.status === filter) && m.title.toLowerCase().includes(search.toLowerCase()));
  const schedules = props.schedules.filter((s) => s.title.toLowerCase().includes(search.toLowerCase()));
  const jobs = props.executions.filter((e) => (place === 'attention' ? e.needsAttention : e.projectId === project?.id) && e.title.toLowerCase().includes(search.toLowerCase()));
  const roster = place === 'station' ? schedules.map((s) => ({ key: s.key, title: s.title, status: s.running ? 'working' : 'idle', detail: s.running ? 'Running' : !s.enabled ? 'Paused' : nextRunLabel(s.nextRunAt), meta: props.projects.find((p) => p.id === s.projectId)?.name }))
    : [...members.map((m) => ({ key: m.key, title: m.title, status: m.status, detail: m.detail, meta: `${m.kind === 'thread' ? 'Thread' : 'CLI Agent'}${m.scheduled ? ' · Scheduled' : ''}${m.teamId ? ' · Team' : ''}` })),
      ...jobs.map((e) => ({ key: e.key, title: e.title, status: e.needsAttention ? 'needs-you' : 'unknown', detail: `Team run · ${e.state.toLowerCase()}`, meta: 'Execution' }))];
  const pages = Math.max(1, Math.ceil(roster.length / PAGE_SIZE)), page = Math.min(pageChoice, pages - 1);
  const title = place === 'all' ? 'All agents' : place === 'station' ? 'Scheduler station' : place === 'library' ? 'Done pavilion' : place === 'attention' ? 'Needs you' : project?.name ?? 'Your city';
  return <section className="agent-city" ref={root} aria-label="Agent City" data-testid="agent-city">
  <style>{cityStyles}</style>
  <div className="city-toolbar">
   <h2>Your agents, a little more alive.</h2>
   <select className="city-control city-project-select" aria-label="Find a project building" value={project?.id ?? ''} onChange={(e) => select(e.target.value)}>
    <option value="" disabled>Find a project…</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.count} live</option>)}
   </select>
   <button type="button" className="city-control" onClick={() => setPaused(!paused)} aria-pressed={paused || reduced} disabled={reduced}>{reduced ? 'Reduced motion' : paused ? 'Resume motion' : 'Pause motion'}</button>
  </div>
  <div className="city-stats" aria-label="Agent status filters">
   <button type="button" className="city-stat" aria-pressed={filter === 'all'} onClick={() => { setInspecting(true); setSelected('all'); setFilter('all'); setPage(0); }}>All <strong>{props.members.length}</strong></button>
   {Object.entries(STATUS_LABELS).map(([status, label]) => <button key={status} type="button" className="city-stat" data-status={status} aria-pressed={filter === status} onClick={() => { setInspecting(true); setSelected('all'); setFilter(status as StatusFilter); setPage(0); }}><i className="city-dot" aria-hidden="true"/>{label} <strong>{counts[status as keyof typeof counts]}</strong></button>)}
   {attention > 0 && <button type="button" className="city-stat city-badge" onClick={() => select('attention')}>Review requests · {attention}</button>}
  </div>
  <div className={`city-layout${inspecting ? ' city-inspecting' : ''}`}>
   <div>
    <div className="city-world" role="group" aria-label="City map. Use plus and minus to zoom, arrow keys to pan, and Home to fit the city." tabIndex={0} {...handlers} data-zoomed={camera.zoom > 1} data-dragging={dragging}>
     <div className="city-maphead">A living view of your projects<strong>{projects.length} projects · one city</strong></div>
     <div className="city-maplayer" style={{ transform: `translate(${camera.x}%, ${camera.y}%) scale(${camera.zoom})` }}>
      <canvas ref={canvas} aria-hidden="true"/>
      {buildings.map((p) => <button type="button" key={p.id} className={`city-label${buildings.length > 6 ? ' city-label-compact' : ''}`} style={labelPosition(p, layout)} onClick={() => select(p.id)} aria-pressed={place === p.id} aria-label={`${p.name}, ${p.count} live agents, ${p.needs} need you`}>
       <strong>{p.name}</strong><span>{p.count} live {p.needs > 0 && <em>{p.needs} need you</em>}</span>
      </button>)}
     </div>
     {!available && <div className="city-empty">The city illustration is unavailable. Use the project selector or status filters to explore your agents.</div>}
     <div className="city-mapfoot"><span>Buildings grow with their teams</span><span>{camera.zoom > 1 ? 'Drag to explore · Home to fit the city' : 'The whole city · zoom in to explore'}</span></div>
    </div>
    <div className="city-places">
     <button type="button" className="city-control" onClick={() => select('station')} aria-pressed={place === 'station'}>Scheduler station · {props.schedules.length}</button>
     <button type="button" className="city-control" onClick={() => select('library')} aria-pressed={place === 'library'}>Done pavilion · {props.members.filter((m) => !m.live).length}</button>
     <div className="city-camera" role="group" aria-label="Map zoom">
      <button type="button" className="city-control" disabled={camera.zoom <= 1} aria-label="Zoom out" onClick={() => zoomBy(.8)}>−</button>
      <output aria-label="Map zoom level">{Math.round(camera.zoom * 100)}%</output>
      <button type="button" className="city-control" disabled={camera.zoom >= 4} aria-label="Zoom in" onClick={() => zoomBy(1.25)}>+</button>
      <button type="button" className="city-control" onClick={fit}>Fit city</button>
     </div>
    </div>
   </div>
   {inspecting && <aside className="city-panel" aria-label="Building roster">
    <div className="city-panel-head"><button type="button" className="city-close" aria-label="Close roster" onClick={() => setInspecting(false)}>×</button><h3>{title}</h3><div className="city-muted">{place === 'station' ? (props.includeScheduled ? 'Upcoming plans and active runs' : 'Use the calendar toggle above to include scheduled agents.')
      : place === 'library' ? 'Exited sessions · inspect to check the outcome' : project ? `${project.count} live · ${project.working} working · ${project.needs} need you` : `${roster.length} items`}</div>
     <input className="city-roster-search" aria-label="Search this roster" placeholder="Find an agent or task…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }}/>
    </div>
    <div className="city-roster">
     {roster.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((item) => <button type="button" className="city-member" data-status={item.status} key={item.key} onClick={() => props.onInspect(item.key)}>
      <i className="city-dot" aria-hidden="true"/><span className="city-member-text"><strong>{item.title}</strong><small>{item.detail}</small><small>{item.meta}</small></span><span aria-hidden="true">↗</span>
     </button>)}
     {roster.length === 0 && <div className="city-empty">{props.searchQuery || search || filter !== 'all' ? 'No matches in this roster.' : place === 'station' ? 'No schedules to display.' : projects.length === 0 ? 'Your projects will appear here. Start an agent to bring the city to life.' : 'A quiet corner of the city. No agents here yet.'}</div>}
    </div>
    {pages > 1 && <div className="city-pagination"><button type="button" className="city-control" disabled={page === 0} onClick={() => setPage(page - 1)} aria-label="Previous roster page">←</button><span>{page + 1} / {pages}</span><button type="button" className="city-control" disabled={page === pages - 1} onClick={() => setPage(page + 1)} aria-label="Next roster page">→</button></div>}
   </aside>}
  </div>
  <div className="city-footer"><span>{props.members.filter((m) => m.live).length} live agents · {projects.length} projects{props.searchQuery ? ' · filtered' : ''}</span><span>Traffic is ambient · agents reflect live state</span></div>
 </section>;
}
export default definePluginApp((app) => {
  // Older hosts keep the plugin in the installed catalogue without adding navigation.
  app.slots.experimental_agentsView?.({ id: 'world', title: 'World', icon: 'Building2', component: AgentCity });
});
