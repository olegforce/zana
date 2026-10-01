import { z } from 'zod';

export const PreviewInputSchema = z.object({
  port: z.number().int().min(1024).max(65535),
  hostId: z.string().min(1).max(100).optional()
}).strict();
export type PreviewInput = z.infer<typeof PreviewInputSchema>;
export interface PreviewView {
  hostId: string;
  hostName: string;
  port: number;
  url: string | null;
  expiresAt: number;
  leases: number;
  status: 'connecting' | 'ready' | 'offline' | 'server-not-responding' | 'update-required' | 'disabled';
  message?: string;
}
export interface PreviewList {
  enabled: boolean;
  shares: PreviewView[];
}
