import { ipcMain } from 'electron';
import { registerSharedProduct } from './shared-product-registry.js';
/** One service handler and authorizer for local IPC and the authenticated product server. */
export function productHandle<A extends unknown[], R>(channel: string, handler: (...args: A) => R): void {
  registerSharedProduct(channel, handler);
  ipcMain.handle(channel, (_event, ...args) => handler(...args as A));
}
export function safeProductHandle<A extends unknown[], R>(channel: string, handler: (...args: A) => R, fallback: (error: unknown) => R): void {
  productHandle(channel, async (...args: A) => {
    try { return await handler(...args); } catch (error) { return fallback(error); }
  });
}
