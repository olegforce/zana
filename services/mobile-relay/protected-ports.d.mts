import type { Server } from 'node:net';
export function protectPreviewServer(server: Server, dataDir?: string): () => void;
export function isProtectedPreviewPort(port: number, dataDir?: string): boolean;

export function protectPreviewPort(port: number, dataDir?: string): () => void;
