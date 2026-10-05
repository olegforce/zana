import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import {
  PLUGIN_METADATA_MAX_BYTES,
  deepFreezePluginMetadata,
  exceedsPluginMetadataLimit,
  parsePersistedPluginMetadata,
  validatePluginMetadata,
} from "./plugin-metadata.js";

describe("plugin metadata", () => {
  it("accepts a plain JSON object under the 256 KiB cap", () => {
    expect(validatePluginMetadata({ ticket: "W-1", nested: { ok: true } })).toEqual({
      ticket: "W-1",
      nested: { ok: true },
    });
    expect(exceedsPluginMetadataLimit("{}")).toBe(false);
  });

  it("accepts nested objects and arrays created by a plugin VM context", () => {
    const metadata = runInNewContext(`({
      slackConversation: 'conversation',
      interactionSurface: { kind: 'remote', label: 'Slack' },
      values: [{ ok: true }, ['nested', null, 1]]
    })`);
    expect(validatePluginMetadata(metadata)).toEqual({
      slackConversation: "conversation",
      interactionSurface: { kind: "remote", label: "Slack" },
      values: [{ ok: true }, ["nested", null, 1]],
    });
  });

  it("accepts dictionaries reconstructed by worker RPC without prototypes", () => {
    const metadata = Object.assign(Object.create(null), {
      slackConversation: "conversation",
      interactionSurface: Object.assign(Object.create(null), { kind: "remote", label: "Slack" }),
      values: [Object.assign(Object.create(null), { ok: true })],
    });
    expect(validatePluginMetadata(metadata)).toEqual({
      slackConversation: "conversation",
      interactionSurface: { kind: "remote", label: "Slack" },
      values: [{ ok: true }],
    });
  });

  it("rejects custom prototypes and classes even when they resemble VM built-ins", () => {
    for (const value of [
      Object.create(Object.create(null)),
      Object.create({ constructor: Object }),
      Object.create({ constructor: "Object" }),
      runInNewContext('new (class Metadata { constructor() { this.ok = true; } })()'),
      { nested: runInNewContext('new (class Values extends Array {})(1, 2)') },
      { nested: new Date() },
    ]) expect(() => validatePluginMetadata(value)).toThrow(/plain JSON data/);
    const cyclic = runInNewContext('const data = {}; data.self = data; data');
    expect(() => validatePluginMetadata(cyclic)).toThrow(/cycle/);
    expect(() => validatePluginMetadata(runInNewContext('({ callback() {} })'))).toThrow();
  });

  it("rejects arrays, custom prototypes, cycles, and oversized payloads", () => {
    expect(() => validatePluginMetadata([])).toThrow(/plain JSON object/);
    expect(() => validatePluginMetadata(null)).toThrow(/plain JSON object/);
    expect(() => validatePluginMetadata(Object.create({ a: 1 }))).toThrow(/plain JSON data/);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => validatePluginMetadata(cyclic)).toThrow(/cycle/);
    const oversized = { blob: "x".repeat(PLUGIN_METADATA_MAX_BYTES) };
    expect(() => validatePluginMetadata(oversized)).toThrow(/256 KiB/);
  });

  it("recovers corrupt persisted JSON to undefined without throwing", () => {
    expect(parsePersistedPluginMetadata("{")).toBeUndefined();
    expect(parsePersistedPluginMetadata("[]")).toBeUndefined();
    expect(parsePersistedPluginMetadata("null")).toBeUndefined();
    expect(parsePersistedPluginMetadata('{"a":1}')).toEqual({ a: 1 });
  });

  it("deep-freezes the namespace so configure callers cannot mutate it", () => {
    const frozen = deepFreezePluginMetadata({ nested: { n: 1 } });
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.nested)).toBe(true);
    expect(() => {
      (frozen as { extra?: string }).extra = "no";
    }).toThrow();
  });
});
