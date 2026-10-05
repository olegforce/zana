import { beforeEach, expect, it, vi } from 'vitest';
import { IPC } from '@zana-ai/zcc-desktop-contract';
import { bindIpcCtx } from './ctx.js';
const h = vi.hoisted(() => ({ uninstall: vi.fn(), clear: vi.fn(), set: vi.fn(), resolveDoc: vi.fn(), trusted: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: { handle() {} }, BrowserWindow: {}, dialog: {}, shell: {} }));
vi.mock('./shared-product-registry.js', () => ({ registerSharedProduct() {} }));
vi.mock('./shared.js', () => ({ trustedProjectRoot: h.trusted, rejectRoot: () => ({ ok: false }) }));
vi.mock('@zana-ai/zcc-server/services/projects/store', () => ({ store: { listProjects: () => [] }, scratchWorkspaceRoot: () => '/unused', worktreeRoot: () => '/unused' }));
vi.mock('@zana-ai/zcc-server/services/extensions/extension-installer', async original => ({ ...await original<typeof import('@zana-ai/zcc-server/services/extensions/extension-installer')>(), uninstallExtension: h.uninstall }));
vi.mock('../extensions/discovery.js', async original => ({ ...await original<typeof import('../extensions/discovery.js')>(), getLocalRecord: async () => null, clearLocal: async () => {}, clearGit: async () => {} }));
vi.mock('../extensions/consent.js', () => ({ revokeConsent: async () => {}, grantConsent() {}, pruneConsentedPermission() {} }));
vi.mock('@zana-ai/zcc-server/services/skills/skill-installer', async original => ({ ...await original<typeof import('@zana-ai/zcc-server/services/skills/skill-installer')>(), removeSkillsForExtension: async () => {} }));
vi.mock('@zana-ai/zcc-server/services/projects/fs', async original => ({ ...await original<typeof import('@zana-ai/zcc-server/services/projects/fs')>(), resolveDoc: h.resolveDoc }));
import { registerExtensionsIpc } from './extensions.js';
import { registerModulesIpc } from './modules.js';
import { registerFsIpc } from './fs.js';
const handlers = new Map<string, (...args: any[]) => any>();
beforeEach(() => {
  vi.clearAllMocks(); handlers.clear(); h.trusted.mockResolvedValue('/trusted'); h.resolveDoc.mockResolvedValue({ ok: true, rel: 'doc.md' });
  bindIpcCtx({
    safeHandle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler),
    moduleRouter: { storageSet: h.set, storageClear: h.clear, teardown: async () => {} },
    extProcessHost: { dispatchLifecycle: async () => {} }, extensionEntries: [], builtinIds: new Set(),
    safeSend() {}, logMainError() {}, runDiskSync: async () => {}, E2E_TAP_ENABLED: false
  } as never);
});
it('acknowledges module storage writes after persistence', async () => {
  registerModulesIpc(); const pending = Promise.withResolvers<void>(); h.set.mockReturnValueOnce(pending.promise);
  const written = vi.fn(); const saving = handlers.get(IPC.modules.storageSet)!('fixture', 'key', 42).then(written);
  await Promise.resolve(); expect(written).not.toHaveBeenCalled(); pending.resolve(); await saving;
  expect(h.set).toHaveBeenCalledWith('fixture', 'key', 42); expect(written).toHaveBeenCalledOnce();
});
it.each([false, true])('purges storage only after a successful uninstall (ok=%s)', async ok => {
  registerExtensionsIpc(); h.uninstall.mockResolvedValue({ ok, value: true });
  const pending = Promise.withResolvers<void>(); h.clear.mockReturnValue(pending.promise);
  const settled = vi.fn(); const removing = handlers.get(IPC.extensions.uninstall)!('fixture').then(settled);
  await vi.waitFor(() => expect(h.uninstall).toHaveBeenCalled());
  if (ok) { expect(h.clear).toHaveBeenCalledWith('fixture'); expect(settled).not.toHaveBeenCalled(); }
  else expect(h.clear).not.toHaveBeenCalled();
  pending.resolve(); await removing;
});
it('awaits document resolution inside the authorized project and rejects untrusted roots', async () => {
  registerFsIpc(); const pending = Promise.withResolvers<any>(); h.resolveDoc.mockReturnValueOnce(pending.promise);
  const read = handlers.get(IPC.fs.resolveDoc)!('/supplied', 'doc.md', '/trusted/subdir');
  await Promise.resolve(); expect(h.resolveDoc).toHaveBeenCalledWith('/trusted', 'doc.md', '/trusted/subdir');
  pending.resolve({ ok: true, rel: 'subdir/doc.md' }); await expect(read).resolves.toMatchObject({ ok: true, relocated: true });
  h.trusted.mockResolvedValueOnce(null); await expect(handlers.get(IPC.fs.resolveDoc)!('/foreign', 'doc.md')).resolves.toMatchObject({ ok: false });
});
