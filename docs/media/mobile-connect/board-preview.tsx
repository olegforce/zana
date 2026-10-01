import React from 'react';
import { createRoot } from 'react-dom/client';
import { Bot, CircleHelp, Loader, Moon, CheckCheck, LayoutGrid, List, Workflow, Calendar, Search, Star, PanelLeft, Bell, Plus, MessageSquare } from '../../../apps/app/node_modules/lucide-react';
import { MobileAgentBoard } from '../../../apps/app/src/components/MobileAgentBoard';
import { FleetKindChip } from '../../../apps/app/src/components/FleetKindChip';
import '../../../apps/app/src/styles/global.css';
import '../../../apps/app/src/styles/mobile-shell.css';
import '../../../apps/app/src/views/agents/mobile-canvas.css';

const data = {
  blocked: [],
  working: [
    { project: 'Zana', color: '#a68cff', title: 'Polish the mobile experience', provider: 'Codex' },
    { project: 'Zana', color: '#a68cff', title: 'Review the latest changes', provider: 'Claude' },
    { project: 'Website', color: '#54bde3', title: 'Improve the getting started guide', provider: 'Codex' }
  ],
  idle: [],
  done: [{ project: 'Zana', color: '#a68cff', title: 'Add the connection walkthrough', provider: 'Codex' }]
};
const lanes = [
 {key:'blocked',label:'Needs you',count:0,icon:<CircleHelp size={16}/>},
 {key:'working',label:'Working',count:3,icon:<Loader size={16}/>},
 {key:'idle',label:'Idle',count:0,icon:<Moon size={16}/>},
 {key:'done',label:'Done',count:1,icon:<CheckCheck size={16}/>}
];
function renderLane(key: string) {
 const rows = data[key as keyof typeof data];
 return [...new Set(rows.map(row=>row.project))].map(project => {
  const items=rows.filter(row=>row.project===project);
  return <div className="agents-lane-group" key={project}>
   <div className="agents-lane-group-head"><span className="agents-lane-group-dot" style={{background:items[0].color}}/><span className="agents-lane-group-name">{project}</span><span className="agents-lane-group-count">{items.length}</span></div>
   {items.map(row=><button key={row.title} className={'agent-card is-thread lane-'+key}>
    {key==='working'&&<span className="agent-card-activity"><span className="agent-card-activity-bar"/></span>}
    <span className="agent-card-head"><span className="agent-card-icon"><Bot size={14}/></span><span className="agent-card-title">{row.title}</span><FleetKindChip kind="thread"/><span className={'tab-agent-dot agent-'+key}/><span className="agent-card-fav"><Star size={13}/></span></span>
    <span className="agent-card-meta"><span className="agent-card-sub">{row.provider} · Local</span></span>
   </button>)}
  </div>
 });
}
function App() {
 return <div className="app-shell" data-mobile="true" id="capture-board">
  <header className="capture-title"><PanelLeft size={18}/><span>Agents</span><span style={{flex:1}}/><Search size={17}/><MessageSquare size={17}/><Bell size={17}/></header>
  <div className="agents-board agents-board--global">
   <div className="agents-board-toolbar">
    <div className="agents-view-toggle">{[LayoutGrid,List,Workflow].map((Icon,i)=><button key={i} className={'agents-view-toggle-btn '+(i===0?'active':'')}><Icon size={14}/>{i===2&&<span className="agents-view-toggle-label">Canvas</span>}</button>)}</div>
    <div className="agents-view-toggle"><button className="agents-view-toggle-btn"><Calendar size={14}/></button></div>
    <button className="btn primary agents-board-new"><Plus size={14}/><span className="agents-board-btn-label">New agent</span></button>
    <div className="agents-board-filter"><Search size={12} className="agents-board-filter-icon"/><input placeholder="Filter by project or task…"/></div>
   </div>
   <div className="agents-board-content"><MobileAgentBoard lanes={lanes} renderLane={renderLane}/></div>
  </div>
 </div>;
}
const style=document.createElement('style');
style.textContent=`html,body,#root{width:430px!important;height:682px!important;margin:0!important;overflow:hidden!important}#capture-board{display:flex!important;flex-direction:column!important;width:430px!important;height:682px!important;min-height:0!important;padding:0!important;grid-template-columns:none!important}.capture-title{display:flex;align-items:center;gap:16px;min-height:48px;padding:0 16px;border-bottom:1px solid var(--border);background:var(--bg-panel);font-size:14px;font-weight:600}.agents-board{flex:1!important;min-height:0!important;width:100%!important;padding:0!important;margin:0!important}.agent-card-fav{display:flex;align-items:center;justify-content:center;color:var(--text-dim)}.agent-card-activity-bar{animation:none!important;left:22%!important}.agent-card{animation:none!important}.mobile-agent-lanes{scrollbar-width:none}body{background:#000!important}`;
document.head.appendChild(style);
createRoot(document.getElementById('root')!).render(<App/>);
