export interface RuntimeProcessSample {
  role: 'daemon' | 'server';
  pid: number;
  createdAt: number;
  /** Interval average; 100% means one logical CPU core. Null while warming up. */
  cpuPercent: number | null;
  memoryBytes: number | null;
}

/** Only the desktop's own two runtime processes; callers cannot supply a PID. */
export interface RuntimePerformanceSnapshot {
  hostId: string | null;
  sampledAt: number;
  processes: RuntimeProcessSample[];
}
