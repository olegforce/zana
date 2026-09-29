import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { createProductHub } from './product-hub.js';

function socket() {
  return Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, bufferedAmount: 0, send: vi.fn(), close: vi.fn() }) as unknown as WebSocket;
}
it('fans out snapshots and Library invalidations once to desktop, without forwarding unrelated events', () => {
  const changed = vi.fn(), hub = createProductHub(changed), client = socket();
  hub.add(client); hub.add(client); expect(hub.size()).toBe(1);
  hub.emit('library:changed', { projectId: 'foreign-owner' });
  expect(changed).toHaveBeenCalledOnce(); expect(client.send).toHaveBeenCalledWith(JSON.stringify({ type: 'library:changed', payload: { projectId: 'foreign-owner' } }));
  hub.emit('threads:updated', {}); expect(changed).toHaveBeenCalledOnce();
  hub.emit('hosts:changed', undefined); expect(changed).toHaveBeenCalledTimes(2);
  hub.pong(client); expect(client.send).toHaveBeenLastCalledWith('{"type":"pong"}');
  client.emit('close'); expect(hub.size()).toBe(0); hub.pong(client);
  changed.mockImplementation(() => { throw new Error('parent closed'); }); expect(() => hub.emit('library:changed', {})).not.toThrow();
  expect(() => createProductHub().emit('library:changed', {})).not.toThrow();
});
it('bounds connected clients and releases a sender after an error', () => {
  const hub = createProductHub();
  const clients = Array.from({ length: 129 }, socket); clients.forEach(client => hub.add(client));
  expect(hub.size()).toBe(128); expect(clients[128]!.close).toHaveBeenCalledWith(1013, 'product-client-limit');
  vi.mocked(clients[0]!.send).mockImplementation(() => { throw new Error('closed'); });
  hub.emit('library:changed', {}); expect(hub.size()).toBe(127);
});
it('invalidates native project readers after HTTP changes without forwarding a client-selected snapshot', () => {
  const library = vi.fn(), projects = vi.fn(), hub = createProductHub(library, projects);
  hub.emit('projects:changed', [{ id: 'server-owned-project' }]);
  expect(projects).toHaveBeenCalledExactlyOnceWith(); expect(library).not.toHaveBeenCalled();
  hub.emit('threads:updated', {}); expect(projects).toHaveBeenCalledOnce();
  projects.mockImplementation(() => { throw new Error('parent closed'); });
  expect(() => hub.emit('projects:changed', [])).not.toThrow();
  expect(() => createProductHub().emit('projects:changed', [])).not.toThrow();
});
