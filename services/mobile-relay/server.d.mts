import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

export interface RelayOptions {
  token: string;
  publicUrl: string;
  allowLocal?: boolean;
  heartbeatMs?: number;
  requestTimeoutMs?: number;
  queueTimeoutMs?: number;
  onVisitor?: (socket: import('ws').WebSocket, request: IncomingMessage) => void;
}

export function createRelay(options: RelayOptions): {
  handleHttp(request: IncomingMessage, response: ServerResponse): void;
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  connected(): boolean;
  close(): void;
};

export function startRelay(options: RelayOptions & { host?: string; port?: number }): Promise<{
  port: number;
  connected(): boolean;
  close(): Promise<void>;
}>;
