import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as framing from "./bounded-line-reader.js";
import {
  BRIDGE_RECORDING_PROCESS_SCOPE,
  createBridgeRecorder,
  createRecordingLineSplitter,
  resolveProviderBridgeRecordDir,
  type BridgeRecordingEntry,
} from "./bridge-recorder.js";

/**
 * The recorder's one non-trivial job is routing: a response carries only an
 * id, so it must land in the scope of the request it answers, on both the
 * runtime→bridge and bridge→runtime sides. Everything else here (append,
 * split, seq) is what the parity harness's merge-by-seq relies on.
 */

let dir: string | undefined;

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function readLane(scope: string, direction: string): BridgeRecordingEntry[] {
  return readFileSync(join(dir!, scope, `${direction}.ndjson`), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as BridgeRecordingEntry);
}

describe("bridge recorder", () => {
  it("routes responses to the scope of the request they answer", () => {
    dir = mkdtempSync(join(tmpdir(), "zcc-bridge-recorder-"));
    const recorder = createBridgeRecorder({ dir });

    recorder.recordRuntimeLine(
      "runtime→bridge",
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    );
    recorder.recordRuntimeLine(
      "bridge→runtime",
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }),
    );
    recorder.recordRuntimeLine(
      "runtime→bridge",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "thread/start",
        params: { threadId: "thr_a" },
      }),
    );
    // A bridge-originated request for thr_a; the runtime's answer carries the
    // bridge's id only.
    recorder.recordRuntimeLine(
      "bridge→runtime",
      JSON.stringify({
        jsonrpc: "2.0",
        id: "br-7",
        method: "interaction/request",
        params: { threadId: "thr_a" },
      }),
    );
    recorder.recordRuntimeLine(
      "runtime→bridge",
      JSON.stringify({ jsonrpc: "2.0", id: "br-7", result: { decision: "allow" } }),
    );
    recorder.recordRuntimeLine(
      "bridge→runtime",
      JSON.stringify({ jsonrpc: "2.0", id: 2, result: { providerThreadId: "p" } }),
    );
    recorder.recordRuntimeLine(
      "bridge→runtime",
      JSON.stringify({
        jsonrpc: "2.0",
        method: "thread/delta",
        params: { threadId: "thr_a", deltas: [] },
      }),
    );
    recorder.close();

    expect(readdirSync(dir).sort()).toEqual([
      BRIDGE_RECORDING_PROCESS_SCOPE,
      "thr_a",
    ]);
    expect(
      readLane(BRIDGE_RECORDING_PROCESS_SCOPE, "runtime→bridge").map(
        (entry) => JSON.parse(entry.line).method,
      ),
    ).toEqual(["initialize"]);
    expect(
      readLane(BRIDGE_RECORDING_PROCESS_SCOPE, "bridge→runtime").map(
        (entry) => JSON.parse(entry.line).id,
      ),
    ).toEqual([1]);
    expect(
      readLane("thr_a", "runtime→bridge").map((entry) => JSON.parse(entry.line).id),
    ).toEqual([2, "br-7"]);
    const outbound = readLane("thr_a", "bridge→runtime");
    expect(outbound.map((entry) => JSON.parse(entry.line).id)).toEqual([
      "br-7",
      2,
      undefined,
    ]);
    // One counter across every lane: merging by seq restores the wire order.
    const all = [
      ...readLane(BRIDGE_RECORDING_PROCESS_SCOPE, "runtime→bridge"),
      ...readLane(BRIDGE_RECORDING_PROCESS_SCOPE, "bridge→runtime"),
      ...readLane("thr_a", "runtime→bridge"),
      ...outbound,
    ]
      .sort((left, right) => left.seq - right.seq)
      .map((entry) => entry.seq);
    expect(all).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("tees a child's stdout and stdin writes as provider lanes", () => {
    dir = mkdtempSync(join(tmpdir(), "zcc-bridge-recorder-"));
    const recorder = createBridgeRecorder({ dir });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    recorder.recordChildIo({ stdin, stdout }, { threadId: "thr_b" });

    stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
    // Partial chunks must reassemble into one recorded line.
    stdout.write('{"jsonrpc":"2.0",');
    stdout.write('"id":1,"result":{}}\n{"jsonrpc":"2.0","method":"turn/started"}\n');
    recorder.close();

    expect(
      readLane("thr_b", "bridge→provider").map((entry) => entry.line),
    ).toEqual(['{"jsonrpc":"2.0","id":1,"method":"initialize"}']);
    expect(
      readLane("thr_b", "provider→bridge").map((entry) => entry.line),
    ).toEqual([
      '{"jsonrpc":"2.0","id":1,"result":{}}',
      '{"jsonrpc":"2.0","method":"turn/started"}',
    ]);
  });

  it.each(["end", "close"])("releases the stdout tee on %s without emitting a partial line", event => {
    dir = mkdtempSync(join(tmpdir(), "zcc-bridge-recorder-"));
    const recorder = createBridgeRecorder({ dir });
    const stdout = new PassThrough();
    recorder.recordChildIo({ stdout }, { threadId: "thr_c" });
    stdout.write("complete\npartial");
    stdout.emit(event);
    expect(stdout.listenerCount("data")).toBe(0);
    expect(stdout.listenerCount("end")).toBe(0);
    expect(stdout.listenerCount("close")).toBe(0);
    stdout.emit("data", "late\n");
    recorder.close();
    expect(readLane("thr_c", "provider→bridge").map(entry => entry.line)).toEqual(["complete"]);
  });

  it.each(["finish", "close"])("restores the stdin writer on %s without flushing a partial line", event => {
    dir = mkdtempSync(join(tmpdir(), "zcc-bridge-recorder-"));
    const recorder = createBridgeRecorder({ dir });
    const stdin = new PassThrough();
    const write = stdin.write;
    recorder.recordChildIo({ stdin }, { threadId: "thr_c" });
    stdin.write("complete\npartial");
    stdin.emit(event);
    expect(stdin.write).toBe(write);
    expect(stdin.listenerCount("finish")).toBe(0);
    expect(stdin.listenerCount("close")).toBe(0);
    stdin.write("late\n");
    recorder.close();
    expect(readLane("thr_c", "bridge→provider").map(entry => entry.line)).toEqual(["complete"]);
  });

  it("disposes retained child pipes on explicit close and ignores later subscriptions", () => {
    dir = mkdtempSync(join(tmpdir(), "zcc-bridge-recorder-"));
    const recorder = createBridgeRecorder({ dir });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const write = stdin.write;
    recorder.recordChildIo({ stdin, stdout }, { threadId: "thr_c" });
    stdin.write("partial");
    stdout.write("partial");
    recorder.close();
    recorder.close();
    recorder.recordChildIo({ stdin, stdout }, { threadId: "thr_c" });
    expect(stdin.write).toBe(write);
    expect(stdin.listenerCount("finish")).toBe(0);
    expect(stdin.listenerCount("close")).toBe(0);
    expect(stdout.listenerCount("data")).toBe(0);
    expect(stdout.listenerCount("end")).toBe(0);
    expect(stdout.listenerCount("close")).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("preserves a newer stdin wrapper when disposing its own tee", () => {
    dir = mkdtempSync(join(tmpdir(), "zcc-bridge-recorder-"));
    const recorder = createBridgeRecorder({ dir });
    const stdin = new PassThrough();
    recorder.recordChildIo({ stdin }, { threadId: "thr_c" });
    const newerWrite = (() => true) as typeof stdin.write;
    stdin.write = newerWrite;
    recorder.close();
    expect(stdin.write).toBe(newerWrite);
    expect(stdin.listenerCount("close")).toBe(0);
  });

  it("stops framing after close even when a later wrapper delegates to the old tee", () => {
    const makeFramer = framing.createBoundedLineFramer;
    let pushes = 0;
    const spy = vi.spyOn(framing, "createBoundedLineFramer").mockImplementation(args => {
      const framer = makeFramer(args);
      return { ...framer, push: chunk => { pushes++; framer.push(chunk); } };
    });
    dir = mkdtempSync(join(tmpdir(), "zcc-bridge-recorder-"));
    const recorder = createBridgeRecorder({ dir });
    const stdin = new PassThrough();
    const forwarded: string[] = [];
    stdin.on("data", chunk => forwarded.push(chunk.toString()));
    try {
      recorder.recordChildIo({ stdin }, { threadId: "thr_c" });
      const tee = stdin.write;
      const newerWrite = ((...args: Parameters<typeof stdin.write>) => tee.apply(stdin, args)) as typeof stdin.write;
      stdin.write = newerWrite;
      stdin.write("partial");
      expect(pushes).toBe(1);
      recorder.close();
      expect(stdin.write).toBe(newerWrite);
      stdin.write("after-close");
      expect(pushes).toBe(1);
      expect(forwarded).toEqual(["partial", "after-close"]);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      recorder.close();
      spy.mockRestore();
    }
  });

  it("drops an oversized line instead of holding it", () => {
    const lines: string[] = [];
    const splitter = createRecordingLineSplitter((line) => lines.push(line), 8);
    splitter.push("short\n");
    splitter.push("this line is far too long");
    splitter.push(" and keeps going\nafter\n");
    expect(lines).toEqual(["short", "after"]);
  });
});

describe("recording line splitter", () => {
  it("clears retained partial and discarded input without emitting a tail", () => {
    const lines: string[] = [];
    const splitter = createRecordingLineSplitter(line => lines.push(line), 4);
    splitter.push("part");
    splitter.clear();
    splitter.push("oversized");
    splitter.clear();
    splitter.push("ok\n");
    expect(lines).toEqual(["ok"]);
  });

  it.each([
    ["12345\nok\nabcdef\nz\n"],
    ["123", "45\nok\nabcdef\nz\n"],
    ["12345", "678", "90\nok\n", "abcdef\nz\n"],
  ])("drops complete and split oversized lines and recovers: %j", (...chunks) => {
    const lines: string[] = [];
    const splitter = createRecordingLineSplitter(line => lines.push(line), 4);
    for (const chunk of chunks) splitter.push(chunk);
    expect(lines).toEqual(["ok", "z"]);
  });

  it("counts bytes across UTF-8 boundaries and preserves valid Unicode", () => {
    const lines: string[] = [];
    const splitter = createRecordingLineSplitter(line => lines.push(line), 4);
    const bytes = Buffer.from("🙂\nééé\n🙂\n");
    for (const byte of bytes) splitter.push(Uint8Array.of(byte));
    expect(lines).toEqual(["🙂", "🙂"]);
  });

  it("handles mixed string and byte chunks without reordering decoded text", () => {
    const lines: string[] = [];
    const splitter = createRecordingLineSplitter(line => lines.push(line), 16);
    const emoji = Buffer.from("🙂");
    splitter.push(emoji.subarray(0, 2));
    splitter.push("x");
    splitter.push(emoji.subarray(2));
    splitter.push("\nafter\n");
    // Invalid byte ordering stays visible as replacement characters rather
    // than silently moving the string ahead of a buffered decoder sequence.
    expect(lines).toEqual(["�x��", "after"]);
  });

  it("accepts exact byte limits, counts CR and drops unterminated tails", () => {
    const lines: string[] = [];
    const splitter = createRecordingLineSplitter(line => lines.push(line), 4);
    splitter.push("1234\nabc");
    splitter.push("\r");
    splitter.push("\nabcd\r\nok\r\npartial");
    expect(lines).toEqual(["1234", "abc", "ok"]);
  });

  it("handles empty chunks and zero-byte caps", () => {
    const lines: string[] = [];
    const splitter = createRecordingLineSplitter(line => lines.push(line), 0);
    splitter.push("");
    splitter.push(new Uint8Array());
    splitter.push("\nx\n\n");
    expect(lines).toEqual(["", ""]);
  });

  it("keeps a realistic multi-megabyte reply intact across small chunks", () => {
    const line = JSON.stringify({ text: `${"é🙂".repeat(700_000)} reply-end` });
    const bytes = Buffer.from(`${line}\n`);
    const lines: string[] = [];
    const splitter = createRecordingLineSplitter(value => lines.push(value));
    for (let offset = 0; offset < bytes.length; offset += 1021) {
      splitter.push(bytes.subarray(offset, offset + 1021));
    }
    expect(lines).toEqual([line]);
  });

  it.each([-1, 1.5, NaN, Infinity])("rejects invalid byte cap %s", maxLineBytes => {
    expect(() => createRecordingLineSplitter(() => {}, maxLineBytes)).toThrow(RangeError);
  });
});

describe("resolveProviderBridgeRecordDir", () => {
  it("prefers a non-empty env override over Settings", () => {
    expect(
      resolveProviderBridgeRecordDir({
        enabled: false,
        dataDir: "/tmp/zcc-data",
        envDir: " /tmp/from-shell ",
      }),
    ).toBe("/tmp/from-shell");
  });

  it("uses the data-dir default when Settings is on", () => {
    expect(
      resolveProviderBridgeRecordDir({
        enabled: true,
        dataDir: "/tmp/zcc-data",
      }),
    ).toBe("/tmp/zcc-data/provider-recordings/raw");
  });

  it("returns undefined when Settings is off and env is empty", () => {
    expect(
      resolveProviderBridgeRecordDir({
        enabled: false,
        dataDir: "/tmp/zcc-data",
        envDir: "  ",
      }),
    ).toBeUndefined();
  });
});
