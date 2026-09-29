import type { ProductHub } from './http/product-hub.js';

/** Trusted main-process invalidations carry no Library snapshot. The runtime
 * tells every client to read its owner-routed state, including native listeners. */
export function forwardRuntimeProductEvent(hub: Pick<ProductHub, 'emit'>, channel: string, args: unknown[]) {
  if (channel === 'product:reset') {
    hub.emit('product:reset', {});
    hub.emit('library:changed', {});
  } else if (channel === 'library:changed') {
    if (args.length) throw new Error('Library invalidations cannot contain a local snapshot');
    hub.emit('library:changed', {});
  } else hub.emit('shared:changed', { channel, args });
}
