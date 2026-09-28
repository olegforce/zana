export type RelayState = 'connecting' | 'connected' | 'reconnecting' | 'stopped';
export function connectRelay(options: { publicUrl: string; token: string; gatewayPort: number; allowLocal?: boolean; onState?: (state: RelayState) => void; retryMs?: number; heartbeatMs?: number; helloTimeoutMs?: number }): { state(): RelayState; close(): void };
