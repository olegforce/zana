import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const h = vi.hoisted(() => ({ sessions: new Map<string, any>(), isLive: null as null | ((id: string) => boolean) }));
vi.mock('../runtime/agent-terminal-budget.js', async original => {
  const actual = await original<typeof import('../runtime/agent-terminal-budget.js')>();
  return { createAgentTerminalBudget: (isLive: (id: string) => boolean) => { h.isLive = isLive; return actual.createAgentTerminalBudget(isLive); } };
});
vi.mock('@zana-ai/zcc-host-daemon/pty', () => ({ PtyManager: class {
  setMcpBaseUrl() {} setProjectRoots() {} setRulesResolver() {}
  getSession(id: string) { return h.sessions.get(id) ?? null; }
}, isClaudeProfile: () => false }));
vi.mock('@zana-ai/zcc-server/services/projects/store', () => ({ store: { listProjects: () => [], getConfig: () => ({}), getProjectSettings: () => ({}) }, scratchWorkspaceRoot: () => '/unused', worktreeRoot: () => '/unused' }));
vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => false },
  app: { on() {}, whenReady: () => new Promise(() => {}), getPath: () => '/tmp', setName() {}, requestSingleInstanceLock: () => true, quit() {} },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null }, ipcMain: { handle() {}, on() {} }, dialog: {}, shell: {}, screen: {},
  Menu: { setApplicationMenu() {}, buildFromTemplate: () => ({}) }, nativeImage: { createFromPath: () => ({}) }, powerMonitor: { on() {} }
}));
vi.mock('../updater.js', () => ({ createUpdater: () => ({}) }));
const dataDir = mkdtempSync(join(tmpdir(), 'agent-owner-authority-'));
vi.stubEnv('ZCC_DATA_DIR', dataDir);
const { createInteractiveTerminal } = await import('../host.js');
beforeEach(() => { h.sessions.clear(); });
afterEach(() => vi.unstubAllGlobals());
afterAll(() => { vi.unstubAllEnvs(); rmSync(dataDir, { recursive: true, force: true }); });
const request = { projectId: 'missing', profile: 'shell' as const, cols: 80, rows: 24 };
it('binds the budget liveness check to the current PTY roster', () => {
  expect(h.isLive!('absent')).toBe(false);
  h.sessions.set('live', { status: 'running' }); expect(h.isLive!('live')).toBe(true);
  h.sessions.set('exited', { status: 'exited' }); expect(h.isLive!('exited')).toBe(false);
});
it.each([42, undefined])('handles invalid or absent owner input %s without granting project access', async owner => {
  const result = await createInteractiveTerminal({ ...request, ...(owner === undefined ? {} : { agentOwnerId: owner as never }) });
  expect(result).toMatchObject({ ok: false, code: owner === undefined ? 'NOT_FOUND' : 'DENIED' });
});
it('rejects agent profiles using a shell owner', async () => {
  expect(await createInteractiveTerminal({ ...request, profile: 'claude', agentOwnerId: 'owner' })).toMatchObject({ ok: false, code: 'DENIED' });
});
it.each([
  [{ projectId: 'foreign', status: 'running' }, 'DENIED'],
  [{ projectId: 'missing', status: 'exited' }, 'DENIED'],
  [{ projectId: 'missing', status: 'running' }, 'NOT_FOUND']
])('validates the local owner before the registered-project launch gate', async (owner, code) => {
  h.sessions.set('owner', owner);
  expect(await createInteractiveTerminal({ ...request, agentOwnerId: 'owner' })).toMatchObject({ ok: false, code });
});
it.each([
  [{ ok: false }, 'DENIED'],
  [{ ok: true, thread: undefined }, 'DENIED'],
  [{ ok: true, thread: { id: 'other', projectId: 'missing' } }, 'DENIED'],
  [{ ok: true, thread: { id: 'owner', projectId: 'foreign' } }, 'DENIED'],
  [{ ok: true, thread: { id: 'owner', projectId: 'missing' } }, 'NOT_FOUND']
])('confines a product-server thread owner to its project', async (response, code) => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: response.ok, json: async () => response })));
  expect(await createInteractiveTerminal({ ...request, agentOwnerId: 'owner' })).toMatchObject({ ok: false, code });
});
it('fails closed when product-server owner validation cannot complete', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw Error('offline'); }));
  expect(await createInteractiveTerminal({ ...request, agentOwnerId: 'owner' })).toMatchObject({ ok: false, code: 'DENIED' });
});
