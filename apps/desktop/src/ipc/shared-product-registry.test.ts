import { beforeEach, expect, it, vi } from 'vitest';
import { SHARED_PRODUCT_METHODS, SHARED_PRODUCT_EVENTS, validSharedProductCall } from '@zana-ai/zcc-contracts/shared-product';
import { IPC } from '@zana-ai/zcc-desktop-contract';
import { authorizeRequest, dispatchOp, type ControlPlaneDeps } from '../control/control-plane.js';
beforeEach(() => vi.resetModules());
it('maps only explicit service methods and events to existing channels', () => {
  for (const [method, channel] of SHARED_PRODUCT_METHODS) {
    const [family, name, nested] = method.split('.');
    const key = nested ? `groups${nested[0]!.toUpperCase()}${nested.slice(1)}` : name!;
    expect((IPC as any)[family!][key], method).toBe(channel);
  }
  for (const [method, channel] of SHARED_PRODUCT_EVENTS) {
    const [family, name, nested] = method.split('.');
    expect((IPC as any)[family!][nested ? 'groupsOnChanged' : name!], method).toBe(channel);
  }
  for (const value of [null, [], {}, { method: 'windows.open', args: [] }, { method: 'config.set', args: {}, }, { method: 'config.set', args: Array(9) }, { method: 'config.get', args: [], url: 'https://evil' }]) expect(validSharedProductCall(value)).toBe(false);
});
it('shares the same authorizer, preserves exceptions, and rejects unknown/native handlers', async () => {
  const { registerSharedProduct, invokeSharedProduct } = await import('./shared-product-registry.js');
  const handler = vi.fn((id: string) => { if (id !== 'registered') throw new Error('project not registered'); return { name: 'Shared' }; });
  registerSharedProduct('projectSettings:get', handler);
  registerSharedProduct('windows:open', () => { throw new Error('must never run'); });
  expect(() => registerSharedProduct('projectSettings:get', handler)).toThrow('Duplicate');
  await expect(invokeSharedProduct({ method: 'projectSettings.get', args: ['registered'] })).resolves.toEqual({ name: 'Shared' });
  await expect(invokeSharedProduct({ method: 'projectSettings.get', args: ['foreign'] })).rejects.toThrow('not registered');
  await expect(invokeSharedProduct({ method: 'windows.open', args: [] })).rejects.toThrow('Unsupported');
  await expect(invokeSharedProduct({ method: 'config.get', args: [] })).rejects.toThrow('update');
});
it('requires the boot-attested product server even for an operator with the control socket token', async () => {
  const invoke = vi.fn(async () => ({ version: 1 }));
  const deps = { invokeSharedProduct: invoke } as unknown as ControlPlaneDeps;
  const args = { method: 'config.get', args: [] };
  for (const caller of ['operator', 'agent', 'orchestrator'] as const) {
    expect(await dispatchOp('product.invoke', args, deps, { class: caller })).toMatchObject({ ok: false });
  }
  expect(invoke).not.toHaveBeenCalled();
  expect(authorizeRequest({ token: 'token', nonce: 'nonce', op: 'product.invoke', args, callerCredential: 'boot-secret' }, { token: 'token', nonce: 'nonce' }, undefined, undefined, secret => secret === 'boot-secret')).toMatchObject({ ok: true, caller: 'product-server' });
  expect(await dispatchOp('product.invoke', args, deps, { class: 'product-server' })).toEqual({ ok: true, value: { version: 1 } });
  invoke.mockRejectedValueOnce(new Error('write failed'));
  expect(await dispatchOp('product.invoke', args, deps, { class: 'product-server' })).toMatchObject({ ok: false, message: 'write failed' });
});
