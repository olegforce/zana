import { SHARED_PRODUCT_METHODS, validSharedProductCall } from '@zana-ai/zcc-contracts/shared-product';
const handlers = new Map<string, (...args: any[]) => unknown>();
const allowedChannels = new Set(SHARED_PRODUCT_METHODS.values());
/** Called only by explicit product registrations, never by renderer-supplied channel names. */
export function registerSharedProduct(channel: string, handler: (...args: any[]) => unknown): void {
  if (!allowedChannels.has(channel)) return;
  if (handlers.has(channel)) throw new Error(`Duplicate shared product handler: ${channel}`);
  handlers.set(channel, handler);
}
export async function invokeSharedProduct(value: unknown): Promise<unknown> {
  if (!validSharedProductCall(value)) throw new Error('Unsupported shared product operation');
  const handler = handlers.get(SHARED_PRODUCT_METHODS.get(value.method)!);
  if (!handler) throw new Error('This shared product operation requires an app update');
  return handler(...value.args);
}
