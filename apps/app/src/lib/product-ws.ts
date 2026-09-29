// Reconnect lifecycle adapted from BB apps/app/src/lib/ws.ts (MIT; see docs/third-party/BB-LICENSE).
export interface ProductWsEvent { type: string; payload: unknown }
type Listener = (event: ProductWsEvent) => void;
let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let openingTimer: ReturnType<typeof setTimeout> | null = null;
let connected = false;
let lastFrame = 0;
const listeners = new Set<Listener>();
const openWaiters = new Set<() => void>();
function dispatch(event: ProductWsEvent) {
  // A failed view must not prevent every other subscriber from receiving data.
  for (const listener of listeners) { try { listener(event); } catch {} }
}
function wsUrl(): string {
  const devPort = typeof __ZCC_DEV_WS_PORT__ === 'number' && Number.isFinite(__ZCC_DEV_WS_PORT__) ? __ZCC_DEV_WS_PORT__ : undefined;
  if (import.meta.env.DEV && devPort) return `ws://127.0.0.1:${devPort}/ws`;
  return `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;
}
function clearHeartbeat() { if (heartbeat) clearInterval(heartbeat); heartbeat = null; }
function clearOpening() { if (openingTimer) clearTimeout(openingTimer); openingTimer = null; }
function disconnect(current: WebSocket) {
  if (socket !== current) return;
  socket = null;
  clearHeartbeat(); clearOpening();
  try { current.close(); } catch {}
  scheduleReconnect();
}
function scheduleReconnect(): void {
  if (reconnectTimer || !listeners.size) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 1500);
}
function connect(): void {
  if (typeof WebSocket === 'undefined' || !listeners.size || socket) return;
  let current: WebSocket;
  try { current = new WebSocket(wsUrl()); socket = current; }
  catch { scheduleReconnect(); return; }
  openingTimer = setTimeout(() => disconnect(current), 15_000);
  current.addEventListener('open', () => {
    if (socket !== current) return;
    clearOpening();
    lastFrame = Date.now();
    const reconnected = connected;
    connected = true;
    for (const resolve of openWaiters) resolve();
    openWaiters.clear();
    clearHeartbeat();
    heartbeat = setInterval(() => {
      if (socket !== current) return;
      if (Date.now() - lastFrame >= 75_000) { disconnect(current); return; }
      try { if (current.readyState === WebSocket.OPEN) current.send('{"type":"ping"}'); }
      catch { disconnect(current); }
    }, 25_000);
    dispatch({ type: 'product:connected', payload: { reconnected } });
  });
  current.addEventListener('message', event => {
    if (socket !== current) return;
    lastFrame = Date.now();
    try {
      const parsed = JSON.parse(String(event.data)) as ProductWsEvent;
      if (!parsed || typeof parsed.type !== 'string' || parsed.type === 'pong') return;
      dispatch(parsed);
    } catch { /* malformed frames never change product state */ }
  });
  current.addEventListener('close', () => {
    if (socket !== current) return;
    disconnect(current);
  });
  current.addEventListener('error', () => disconnect(current));
}
export function subscribeProductWs(listener: Listener): () => void {
  listeners.add(listener); connect();
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    const old = socket; socket = null;
    try { old?.close(); } catch {}
    clearHeartbeat(); clearOpening();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null; connected = false;
    openWaiters.clear();
  };
}
/** Reconcile using reads only. Never replay a launch, keystroke, or mutation. */
export function subscribeProductReconnect(callback: () => void | Promise<void>): () => void {
  let running = false, pending = false, stopped = false;
  async function refresh() {
    pending = true;
    if (running) return;
    running = true;
    try {
      do { pending = false; try { await callback(); } catch {} }
      while (pending && !stopped);
    } finally { running = false; }
  }
  const stop = subscribeProductWs(event => {
    if (event.type === 'product:reset' || (event.type === 'product:connected' && (event.payload as { reconnected?: boolean })?.reconnected)) void refresh();
  });
  return () => { stopped = true; stop(); };
}
export function subscribeProductEvent<T>(type: string, callback: (payload: T) => void): () => void {
  return subscribeProductWs(event => { if (event.type === type) callback(event.payload as T); });
}

export function waitForProductWsOpen(): Promise<void> {
  connect();
  if (socket?.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve) => openWaiters.add(resolve));
}
