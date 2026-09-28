import { describe, expect, it, vi } from 'vitest';
import { createRuntimeRecovery } from './runtime-recovery.js';
describe('runtime crash recovery', () => {
  it.each([true, false])('offers one deliberate restart, selection=%s', async choice => {
    const deps = { showDialog: vi.fn(async () => choice), log: vi.fn(), restart: vi.fn() };
    const recovery = createRuntimeRecovery(deps);
    recovery.notify('server'); recovery.notify('daemon');
    await Promise.resolve();
    expect(deps.showDialog).toHaveBeenCalledTimes(1);
    expect(deps.log).toHaveBeenCalledWith('server');
    expect(deps.restart).toHaveBeenCalledTimes(choice ? 1 : 0);
  });
  it('never restarts during intentional shutdown', async () => {
    const deps = { showDialog: vi.fn(async () => true), log: vi.fn(), restart: vi.fn() };
    const recovery = createRuntimeRecovery(deps);
    recovery.notify('server'); recovery.dispose(); recovery.notify('daemon');
    await Promise.resolve(); expect(deps.restart).not.toHaveBeenCalled();
  });
  it('allows a later notification if the dialog failed', async () => {
    const deps = { showDialog: vi.fn().mockRejectedValueOnce(new Error('window gone')).mockResolvedValue(false), log: vi.fn(), restart: vi.fn() };
    const recovery = createRuntimeRecovery(deps);
    recovery.notify('server'); await Promise.resolve(); await Promise.resolve();
    recovery.notify('daemon'); expect(deps.showDialog).toHaveBeenCalledTimes(2);
  });
});
