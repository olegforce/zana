/** Connection lifecycle adapted from BB's server-connection.ts / support.ts (MIT).
 * Attribution and license: docs/third-party/bb-shared-machines.md / BB-LICENSE. */
import ReconnectingWebSocket from 'partysocket/ws';
import NodeWebSocket from 'ws';
import {
  HOST_RPC_PROTOCOL_VERSION,
  HostHelloMessageSchema,
  HostHelloOkMessageSchema,
  HostHeartbeatAckMessageSchema,
  HostReadyMessageSchema,
  HostReadyOkMessageSchema,
  type HostRuntimeSnapshot,
  type HostHelloOkMessage
} from '@zana-ai/zcc-contracts/host-rpc';
import { joinServerWsUrl } from './server-url.js';

export const HOST_CONNECTION_TIMEOUT_MS = 10_000;
export const HOST_STARTUP_TIMEOUT_MS = 60_000;

export class HostAuthenticationError extends Error {}
export class HostSupersededError extends Error {}

export interface HostServerSocketOptions {
  serverUrl: string;
  hostId: string;
  hostKey: string;
  instanceId: string;
  connectCredential?: string;
  keepRetryingStartup?: boolean;
  getRuntimeSnapshot?: () => HostRuntimeSnapshot;
  onTerminated?: () => void;
  onHello(hello: HostHelloOkMessage): Promise<void>;
  onMessage(message: unknown, reply: (response: string) => void): void;
  onConnectionChange(connected: boolean): void;
  onSocketClose?: (code: number) => void;
}

/** Like BB, use ws on every enrollment path and let PartySocket own retries.
 * Never buffer application messages here: event delivery owns its durable queue. */
export function createHostServerSocket(options: HostServerSocketOptions) {
  const url = joinServerWsUrl(options.serverUrl, '/internal/hosts/ws');
  const headers = {
    'x-zcc-host-id': options.hostId,
    authorization: `Bearer ${options.hostKey}`,
    ...(options.connectCredential ? { 'x-zcc-machine-credential': options.connectCredential } : {})
  };
  class AuthenticatedWebSocket extends NodeWebSocket {
    constructor(address: string | URL, protocols?: string | string[]) {
      super(address, protocols, { headers, followRedirects: false, handshakeTimeout: HOST_CONNECTION_TIMEOUT_MS });
    }
  }
  const socket = new ReconnectingWebSocket(url.toString(), [], {
    WebSocket: AuthenticatedWebSocket,
    minReconnectionDelay: 1_000,
    maxReconnectionDelay: 30_000,
    reconnectionDelayGrowFactor: 2,
    connectionTimeout: HOST_CONNECTION_TIMEOUT_MS,
    maxRetries: Number.POSITIVE_INFINITY,
    maxEnqueuedMessages: 0,
    startClosed: true
  });
  let stopped = false;
  let connected = false;
  let generation = 0;
  let acceptingHello = false;
  let pendingHello: HostHelloOkMessage | undefined;
  let settled = false;
  let helloTimer: ReturnType<typeof setTimeout> | undefined;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let recoveryAttempts = 0;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let lastAcknowledgedAt = 0;
  let lastTickAt = 0;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const startupTimer = options.keepRetryingStartup ? undefined
    : setTimeout(() => fail(new Error('Host server connection timed out')), HOST_STARTUP_TIMEOUT_MS);

  function clearSession(): void {
    generation++;
    acceptingHello = false;
    pendingHello = undefined;
    clearTimeout(helloTimer);
    clearInterval(heartbeatTimer);
    helloTimer = undefined;
    heartbeatTimer = undefined;
    if (connected) {
      connected = false;
      options.onConnectionChange(false);
    }
  }

  function fail(error: Error): void {
    if (!settled) { settled = true; rejectReady(error); }
    close();
    options.onTerminated?.();
  }

  function reconnect(reason: string): void {
    if (stopped || recoveryTimer) return;
    console.warn(`[host-connection] ${options.hostId}: ${reason}; reconnecting`);
    clearSession();
    // PartySocket.reconnect resets its retry count. Pace intentional retries
    // too, so repeated reconciliation failures cannot spin at socket speed.
    socket.close(1013, reason);
    recoveryTimer = setTimeout(() => {
      recoveryTimer = undefined;
      if (!stopped) socket.reconnect();
    }, Math.min(30_000, 1_000 * 2 ** Math.min(recoveryAttempts++, 5)));
  }

  function heartbeat(hello: HostHelloOkMessage): void {
    lastAcknowledgedAt = lastTickAt = Date.now();
    heartbeatTimer = setInterval(() => {
      const now = Date.now();
      // BB gives a resumed machine a fresh lease rather than treating sleep
      // as proof of a dead transport. Missing replies still expire that lease.
      if (now - lastTickAt > hello.leaseTimeoutMs) lastAcknowledgedAt = now;
      lastTickAt = now;
      if (!connected || socket.readyState !== NodeWebSocket.OPEN) return;
      if (now - lastAcknowledgedAt > hello.leaseTimeoutMs) {
        reconnect('heartbeat-ack-timeout');
        return;
      }
      socket.send(JSON.stringify({ type: 'heartbeat' }));
    }, hello.heartbeatIntervalMs);
  }

  socket.onopen = () => {
    if (stopped) return;
    clearSession();
    helloTimer = setTimeout(() => reconnect('hello-timeout'), HOST_CONNECTION_TIMEOUT_MS);
    socket.send(JSON.stringify(HostHelloMessageSchema.parse({
      type: 'host.hello', protocolVersion: HOST_RPC_PROTOCOL_VERSION,
      hostId: options.hostId, instanceId: options.instanceId
    })));
  };
  socket.onmessage = event => {
    if (stopped) return;
    let message: unknown;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    const hello = HostHelloOkMessageSchema.safeParse(message);
    if (hello.success) {
      if (hello.data.hostId !== options.hostId || acceptingHello || connected) return;
      acceptingHello = true;
      const current = generation;
      void options.onHello(hello.data).then(() => {
        if (stopped || current !== generation || socket.readyState !== NodeWebSocket.OPEN) return;
        pendingHello = hello.data;
        socket.send(JSON.stringify(HostReadyMessageSchema.parse({
          type: 'host.ready', protocolVersion: HOST_RPC_PROTOCOL_VERSION,
          hostId: options.hostId, instanceId: options.instanceId,
          runtime: options.getRuntimeSnapshot?.() ?? { threads: [], loadedEnvironments: [] }
        })));
      }).catch(() => { if (current === generation) reconnect('plugin-reconciliation-failed'); });
      return;
    }
    const accepted = HostReadyOkMessageSchema.safeParse(message);
    if (accepted.success) {
      if (!pendingHello || connected || accepted.data.hostId !== options.hostId || accepted.data.instanceId !== options.instanceId) return;
      clearTimeout(helloTimer);
      connected = true;
      recoveryAttempts = 0;
      heartbeat(pendingHello);
      pendingHello = undefined;
      options.onConnectionChange(true);
      console.info(`[host-connection] ${options.hostId}: connected`);
      clearTimeout(startupTimer);
      if (!settled) { settled = true; resolveReady(); }
      return;
    }
    if (!connected) return;
    if (HostHeartbeatAckMessageSchema.safeParse(message).success) {
      lastAcknowledgedAt = Date.now();
      return;
    }
    const current = generation;
    options.onMessage(message, response => {
      if (current === generation && connected && !stopped && socket.readyState === NodeWebSocket.OPEN) socket.send(response);
    });
  };
  socket.onerror = event => {
    if (stopped) return;
    // Do not log the raw error/URL: enrolled credentials must stay private.
    const status = /Unexpected server response: (401|403)\b/.exec(event.message)?.[1];
    if (status) {
      console.warn(`[host-connection] ${options.hostId}: authentication rejected (${status})`);
      fail(new HostAuthenticationError(`Host server rejected credentials (${status})`));
    } else console.warn(`[host-connection] ${options.hostId}: connection failed; retrying`);
  };
  socket.onclose = event => {
    clearSession();
    if (stopped) return;
    console.warn(`[host-connection] ${options.hostId}: disconnected (${event.code})`);
    options.onSocketClose?.(event.code);
    if (event.code === 4003) {
      fail(new HostSupersededError('Host daemon superseded by another process'));
      return;
    }
    // A background daemon keeps retrying if the updater/server is unavailable.
    if (!settled && !options.keepRetryingStartup && (event.code === 4001 || event.code === 4002)) {
      fail(new Error('incompatible host-rpc protocol version'));
    }
  };

  function close(): void {
    if (stopped) return;
    stopped = true;
    clearTimeout(startupTimer);
    clearTimeout(recoveryTimer);
    clearSession();
    if (!settled) { settled = true; rejectReady(new Error('Host connection closed before hello')); }
    socket.close();
  }
  socket.reconnect();
  return {
    ready,
    get connected() { return connected; },
    send(data: string): boolean {
      if (!connected || socket.readyState !== NodeWebSocket.OPEN || stopped) return false;
      socket.send(data);
      return true;
    },
    reconnect,
    close
  };
}
