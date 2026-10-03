/**
 * Bridge record mode.
 *
 * When `ZCC_PROVIDER_BRIDGE_RECORD_DIR` names a directory, a bridge process
 * tees every line that crosses its two boundaries into NDJSON files:
 *
 *   - the runtime wire (stdin/stdout of the bridge process), recorded by the
 *     bootstrap in `bridge-worker-entry.ts` for every bridge, first- or
 *     third-party;
 *   - the provider wire (the child the bridge supervises), recorded by the
 *     bridge itself through `experimental_recordProviderChildIo`.
 *
 * The files are the raw material of the parity harness: a recording replays
 * the provider lane into a fake child and the runtime lane into a bridge, so
 * two bridge versions can be diffed on real traffic instead of scripted fakes.
 *
 * Layout under the directory: `<scope>/<direction>.ndjson`, where `scope` is
 * the thread id the line belongs to, or `_process` for lines that belong to
 * no thread (initialize, model/list, provider health, and the children those
 * spawn). One entry per line: `{ ts, run, seq, dir, line }`. `seq` is a
 * single counter across every lane of the process and `run` identifies the
 * process, so the four files of a scope merge back into their exact order
 * even when several bridge processes served the thread.
 *
 * Off by default. Complete lines are appended as they cross; partial lines
 * use the protocol's bounded byte framer, without retaining session history.
 * The recorder is
 * a process-wide singleton keyed in `globalThis` rather than a module-level
 * variable because a plugin's host artifact bundles its own copy of this
 * module — the bootstrap and the bridge must still share one counter.
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  createBoundedLineFramer,
  MAX_JSON_RPC_LINE_BYTES,
} from "./bounded-line-reader.js";

export const PROVIDER_BRIDGE_RECORD_DIR_ENV = "ZCC_PROVIDER_BRIDGE_RECORD_DIR";

/** Layout under the host data dir when Settings enables record mode. */
export const PROVIDER_BRIDGE_RECORD_SUBDIR = "provider-recordings/raw";

export function defaultProviderBridgeRecordDir(dataDir: string): string {
  return join(dataDir, PROVIDER_BRIDGE_RECORD_SUBDIR);
}

/**
 * Record-mode directory for a spawn. A non-empty `ZCC_PROVIDER_BRIDGE_RECORD_DIR`
 * always wins (dev shell / test override). Otherwise Settings
 * `providerBridgeRecordingEnabled` uses the data-dir default. Off otherwise.
 */
export function resolveProviderBridgeRecordDir(args: {
  enabled: boolean;
  dataDir: string;
  envDir?: string;
}): string | undefined {
  const fromEnv = args.envDir?.trim();
  if (fromEnv) return fromEnv;
  if (args.enabled) return defaultProviderBridgeRecordDir(args.dataDir);
  return undefined;
}

export const BRIDGE_RECORDING_DIRECTIONS = [
  "runtime→bridge",
  "bridge→runtime",
  "provider→bridge",
  "bridge→provider",
] as const;

export type BridgeRecordingDirection =
  (typeof BRIDGE_RECORDING_DIRECTIONS)[number];

export type BridgeRecordingRuntimeDirection = Extract<
  BridgeRecordingDirection,
  "runtime→bridge" | "bridge→runtime"
>;

/** The scope directory for lines that belong to no thread. */
export const BRIDGE_RECORDING_PROCESS_SCOPE = "_process";

export interface BridgeRecordingEntry {
  /** Wall-clock milliseconds when the line crossed. */
  ts: number;
  /**
   * The recorder's start time, identifying the bridge process that wrote the
   * entry. A thread can span several bridge processes (the runtime restarts a
   * bridge, or releases and later resumes the thread), each appending to the
   * same files with its own `seq`; `(run, seq)` orders entries exactly.
   */
  run: number;
  /** Process-wide monotonic counter across all four lanes. */
  seq: number;
  dir: BridgeRecordingDirection;
  /** The raw line, without its terminator. */
  line: string;
}

export function bridgeRecordingFileName(
  direction: BridgeRecordingDirection,
): string {
  return `${direction}.ndjson`;
}

export interface RecordBridgeLineArgs {
  direction: BridgeRecordingDirection;
  line: string;
  /** The thread the line belongs to; null records under `_process`. */
  threadId: string | null;
}

export interface BridgeRecorderChildStreams {
  stdin?: Writable | null;
  stdout?: Readable | null;
}

export interface BridgeRecorder {
  /** The directory this process records into. */
  readonly dir: string;
  record(args: RecordBridgeLineArgs): void;
  /**
   * Record a runtime-lane JSON-RPC line, routing it to the thread it belongs
   * to: a request by `params.threadId`, a response by the request it answers.
   */
  recordRuntimeLine(
    direction: BridgeRecordingRuntimeDirection,
    line: string,
  ): void;
  /**
   * Tee a provider child's stdio. Lines the child writes are recorded as
   * `provider→bridge`; lines the bridge writes to it as `bridge→provider`.
   */
  recordChildIo(
    child: BridgeRecorderChildStreams,
    scope: { threadId: string | null },
  ): void;
  close(): void;
}

/**
 * Split a chunked byte/string stream into complete lines with the same
 * per-line cap the protocol's line reader applies: an oversized line is
 * dropped rather than held in memory.
 */
export function createRecordingLineSplitter(
  onLine: (line: string) => void,
  maxLineBytes: number = MAX_JSON_RPC_LINE_BYTES,
): { push: (chunk: string | Uint8Array) => void; clear: () => void } {
  const framer = createBoundedLineFramer({
    onLine,
    // Recording is a tee: discard oversized diagnostics without interrupting
    // the provider's pipe. The protocol reader reports its own overflows.
    onOverflow: () => {},
    maxLineBytes,
  });
  // Tees record complete lines only; do not flush an unterminated tail.
  return { push: framer.push, clear: framer.clear };
}

function safeScopeSegment(threadId: string | null): string {
  if (threadId === null || threadId === "") {
    return BRIDGE_RECORDING_PROCESS_SCOPE;
  }
  const sanitized = threadId.replace(/[^A-Za-z0-9_.-]+/g, "-");
  return sanitized === "" || sanitized.startsWith("_")
    ? `t-${sanitized}`
    : sanitized;
}

interface ParsedRuntimeLine {
  id: string | number | undefined;
  method: string | undefined;
  threadId: string | undefined;
}

function parseRuntimeLine(line: string): ParsedRuntimeLine | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const id =
    typeof record.id === "string" || typeof record.id === "number"
      ? record.id
      : undefined;
  const method = typeof record.method === "string" ? record.method : undefined;
  const params = record.params;
  const threadId =
    typeof params === "object" &&
    params !== null &&
    typeof (params as Record<string, unknown>).threadId === "string"
      ? ((params as Record<string, unknown>).threadId as string)
      : undefined;
  return { id, method, threadId };
}

function pendingKey(id: string | number): string {
  return `${typeof id}:${String(id)}`;
}

export function createBridgeRecorder(args: { dir: string }): BridgeRecorder {
  const dir = resolve(args.dir);
  const fds = new Map<string, number>();
  const childIoCleanups = new Set<() => void>();
  // Requests the runtime sent, awaiting the bridge's response; and requests
  // the bridge sent (tool calls, interactions), awaiting the runtime's.
  const runtimeRequestThreads = new Map<string, string | null>();
  const bridgeRequestThreads = new Map<string, string | null>();
  const run = Date.now();
  let seq = 0;
  let closed = false;

  function trackCleanup(release: () => void): () => void {
    const cleanup = () => {
      if (!childIoCleanups.delete(cleanup)) return;
      release();
    };
    childIoCleanups.add(cleanup);
    return cleanup;
  }

  function fdFor(scope: string, direction: BridgeRecordingDirection): number {
    const key = `${scope} ${direction}`;
    const existing = fds.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const scopeDir = join(dir, scope);
    mkdirSync(scopeDir, { recursive: true });
    const fd = openSync(join(scopeDir, bridgeRecordingFileName(direction)), "a");
    fds.set(key, fd);
    return fd;
  }

  function record(recordArgs: RecordBridgeLineArgs): void {
    if (closed) {
      return;
    }
    seq += 1;
    const entry: BridgeRecordingEntry = {
      ts: Date.now(),
      run,
      seq,
      dir: recordArgs.direction,
      line: recordArgs.line,
    };
    try {
      writeSync(
        fdFor(safeScopeSegment(recordArgs.threadId), recordArgs.direction),
        `${JSON.stringify(entry)}\n`,
      );
    } catch (error) {
      // Recording is diagnostics: a full disk must not take the bridge down.
      process.stderr.write(
        `provider bridge recorder: failed to append to ${dir}: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }

  function recordRuntimeLine(
    direction: BridgeRecordingRuntimeDirection,
    line: string,
  ): void {
    const parsed = parseRuntimeLine(line);
    let threadId: string | null = parsed?.threadId ?? null;
    if (parsed !== null && parsed.id !== undefined) {
      const key = pendingKey(parsed.id);
      if (parsed.method !== undefined) {
        // A request: remember which thread it belongs to so its response,
        // which carries only the id, lands in the same scope.
        (direction === "runtime→bridge"
          ? runtimeRequestThreads
          : bridgeRequestThreads
        ).set(key, threadId);
      } else {
        const pending =
          direction === "runtime→bridge"
            ? bridgeRequestThreads
            : runtimeRequestThreads;
        const owner = pending.get(key);
        if (owner !== undefined) {
          pending.delete(key);
          threadId = owner;
        }
      }
    }
    record({ direction, line, threadId });
  }

  function recordChildIo(
    child: BridgeRecorderChildStreams,
    scope: { threadId: string | null },
  ): void {
    if (closed) return;
    const { stdin, stdout } = child;
    if (stdout) {
      const splitter = createRecordingLineSplitter((line) =>
        record({ direction: "provider→bridge", line, threadId: scope.threadId }),
      );
      const cleanup = trackCleanup(() => {
        splitter.clear();
        stdout.removeListener("data", splitter.push);
        stdout.removeListener("end", cleanup);
        stdout.removeListener("close", cleanup);
      });
      stdout.on("data", splitter.push);
      stdout.once("end", cleanup);
      stdout.once("close", cleanup);
    }
    if (stdin) {
      const splitter = createRecordingLineSplitter((line) =>
        record({ direction: "bridge→provider", line, threadId: scope.threadId }),
      );
      let active = true;
      const originalWrite = stdin.write;
      const wrappedWrite = ((
        chunk: string | Uint8Array,
        ...rest: unknown[]
      ): boolean => {
        if (active) splitter.push(chunk);
        return (originalWrite as (...args: unknown[]) => boolean).call(
          stdin,
          chunk,
          ...rest,
        );
      }) as typeof stdin.write;
      const cleanup = trackCleanup(() => {
        active = false;
        splitter.clear();
        // Another consumer may have installed a later wrapper; never remove
        // it while disposing our tee.
        if (stdin.write === wrappedWrite) stdin.write = originalWrite;
        stdin.removeListener("finish", cleanup);
        stdin.removeListener("close", cleanup);
      });
      stdin.write = wrappedWrite;
      stdin.once("finish", cleanup);
      stdin.once("close", cleanup);
    }
  }

  return {
    dir,
    record,
    recordRuntimeLine,
    recordChildIo,
    close() {
      closed = true;
      for (const cleanup of childIoCleanups) cleanup();
      for (const fd of fds.values()) {
        try {
          closeSync(fd);
        } catch {
          // Already closed.
        }
      }
      fds.clear();
    },
  };
}

const RECORDER_GLOBAL_KEY = Symbol.for("zcc.providerBridgeRecorder");

interface RecorderGlobalSlot {
  recorder: BridgeRecorder | null;
  resolved: boolean;
}

function globalSlot(): RecorderGlobalSlot {
  const holder = globalThis as unknown as Record<symbol, RecorderGlobalSlot>;
  const existing = holder[RECORDER_GLOBAL_KEY];
  if (existing !== undefined) {
    return existing;
  }
  const slot: RecorderGlobalSlot = { recorder: null, resolved: false };
  holder[RECORDER_GLOBAL_KEY] = slot;
  return slot;
}

/**
 * The process's recorder, created from `ZCC_PROVIDER_BRIDGE_RECORD_DIR` on
 * first use; null when record mode is off. Shared across every copy of this
 * module in the process.
 */
export function getBridgeRecorder(): BridgeRecorder | null {
  const slot = globalSlot();
  if (!slot.resolved) {
    slot.resolved = true;
    const dir = process.env[PROVIDER_BRIDGE_RECORD_DIR_ENV];
    if (dir !== undefined && dir.trim() !== "") {
      slot.recorder = createBridgeRecorder({ dir: dir.trim() });
    }
  }
  return slot.recorder;
}

/** Test seam: install (or clear with null) the process recorder. */
export function setBridgeRecorderForTesting(
  recorder: BridgeRecorder | null,
): void {
  const slot = globalSlot();
  slot.recorder = recorder;
  slot.resolved = true;
}

/**
 * Whether this process records. A bridge whose provider pipe is owned by an
 * SDK (Claude's Agent SDK) checks this to decide whether to take the spawn
 * over; bridges that spawn their child themselves just call
 * `experimental_recordProviderChildIo`.
 */
export function experimental_isProviderBridgeRecording(): boolean {
  return getBridgeRecorder() !== null;
}

/**
 * Tee the provider child a bridge just spawned into the recording, scoped to
 * the thread it serves (null for process-level children such as a
 * model-list probe). A no-op unless record mode is on, so bridges call it
 * unconditionally right after `spawn()`.
 */
export function experimental_recordProviderChildIo(
  child: BridgeRecorderChildStreams,
  scope: { threadId: string | null },
): void {
  getBridgeRecorder()?.recordChildIo(child, scope);
}
