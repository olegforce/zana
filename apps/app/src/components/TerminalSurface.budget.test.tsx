// @vitest-environment happy-dom
import { cleanup,render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach,expect,it,vi } from 'vitest';
const h=vi.hoisted(() => ({ terminals:{} as Record<string,any[]>,ui:{ nav:'projects',selectedProjectId:'p',selectedTabId:{p:'s0'},splitLayout:{},splitTabIds:{},agentModal:null,agentMonitor:null,threadPanelTerminal:null } }));
vi.mock('../store.js',() => ({ useData:(pick:any) => pick({terminals:h.terminals}),useUi:(pick:any) => pick(h.ui) }));
vi.mock('../lib/split-layout/store.js',() => ({useSplitWorkspace:(pick:any) => pick({layout:null})}));
vi.mock('../lib/split-layout/agentSessionPortal.js',() => ({ pickAgentSessionPortalTarget:() => null,pickProjectTerminalsPortalTarget:() => null,agentSessionAnchorId:() => '',projectTerminalsAnchorId:() => ''}));
vi.mock('./TerminalView.js',() => ({TerminalView:({session,area,scrollbackLimit}:any) => <div data-session={session.id} data-area={area??'hidden'} data-limit={scrollbackLimit}/> }));
import { TerminalSurface,PROJECTS_TERMINAL_ANCHOR_ID } from './TerminalSurface.js';
afterEach(cleanup);
it.each([[1,50000],[16,12500],[64,3125]])('passes the aggregate history allocation to all %i mounted sessions', (count,limit) => {
  h.terminals={p:Array.from({length:count},(_,index) => ({id:`s${index}`,projectId:'p',profile:'shell'}))};
  const view=render(<MemoryRouter initialEntries={['/projects/p/terminals']}><div id={PROJECTS_TERMINAL_ANCHOR_ID}/><TerminalSurface/></MemoryRouter>);
  const sessions=view.container.querySelectorAll('[data-session]');
  expect(sessions).toHaveLength(count);
  expect([...sessions].every(node => node.getAttribute('data-limit')===String(limit))).toBe(true);
  expect([...sessions].filter(node => node.getAttribute('data-area')!=='hidden')).toHaveLength(1);
});
