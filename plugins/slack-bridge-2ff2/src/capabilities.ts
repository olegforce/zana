import { featureEnabled } from "./access.js";
import { createHash } from "node:crypto";
import catalog from "./catalog.js";
import type { Bridge } from "./bridge.js";

export const builtInCapabilities = catalog.tools;
export const slackCommands = catalog.commands;
type Field = {
  type: "string" | "number" | "boolean";
  description: string;
  maxLength?: number;
  enum?: (string | number | boolean)[];
};
export type SlackCapability = {
  id: string;
  title: string;
  description: string;
  /** Bump when the scope or semantics of execute changes; existing consent expires. */
  version: number;
  readOnly: true;
  fields: Record<string, Field>;
  required?: string[];
  execute(
    args: Record<string, unknown>,
    context: {
      projectId: string;
      slackUserId: string;
      teamId: string;
      signal: AbortSignal;
    },
  ): Promise<Record<string, unknown>>;
};
export type SlackCapabilityService = {
  register(pluginId: string, capability: SlackCapability): () => void;
};
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const fail = (error: string, message: string) => ({
  isError: true,
  error,
  message,
});

/** Only opt-in tools, never the unrestricted host tool registry. Plugins are locally trusted code. */
export class SlackCapabilities implements SlackCapabilityService {
  private entries = new Map<
    string,
    {
      definition: SlackCapability;
      digest: string;
      pluginId: string;
      inputSchema: Record<string, unknown>;
    }
  >();
  private active = new Set<AbortController>();
  constructor(private bridge: Bridge) {}
  register(pluginId: string, definition: SlackCapability): () => void {
    if (
      !/^[a-z0-9][a-z0-9-]{0,79}$/.test(pluginId) ||
      !/^[a-z][a-z0-9_]{0,49}$/.test(definition.id) ||
      !definition.title?.trim() ||
      definition.title.length > 100 ||
      !definition.description?.trim() ||
      definition.description.length > 1000 ||
      !Number.isSafeInteger(definition.version) ||
      definition.version < 1 ||
      definition.readOnly !== true ||
      typeof definition.execute !== "function" ||
      !record(definition.fields) ||
      Object.keys(definition.fields).length > 12
    )
      throw new Error("Invalid read-only Slack capability.");
    for (const [key, field] of Object.entries(definition.fields)) {
      if (
        !/^[a-z][a-z0-9_]{0,49}$/.test(key) ||
        key === "project_id" ||
        !record(field) ||
        !["string", "number", "boolean"].includes(field.type) ||
        typeof field.description !== "string" ||
        field.description.length > 500 ||
        Object.keys(field).some(
          (k) => !["type", "description", "maxLength", "enum"].includes(k),
        ) ||
        (field.maxLength !== undefined &&
          (field.type !== "string" ||
            !Number.isInteger(field.maxLength) ||
            field.maxLength < 1 ||
            field.maxLength > 4000)) ||
        (field.enum !== undefined &&
          (!Array.isArray(field.enum) ||
            !field.enum.length ||
            field.enum.length > 30 ||
            field.enum.some(
              (v) =>
                typeof v !== field.type ||
                (typeof v === "string" && v.length > 4000),
            )))
      )
        throw new Error("Unsupported Slack capability field.");
    }
    if (
      definition.required !== undefined &&
      (!Array.isArray(definition.required) ||
        definition.required.some((k) => !Object.hasOwn(definition.fields, k)))
    )
      throw new Error("Invalid required capability fields.");
    const id = `${pluginId}.${definition.id}`;
    if (this.entries.has(id) || this.entries.size >= 50)
      throw new Error("Slack capability already registered or catalog full.");
    // Copy metadata: a contributor cannot broaden an enabled schema by mutating its original object.
    const { execute, ...meta } = definition;
    const frozen = JSON.parse(JSON.stringify(meta)) as Omit<
      SlackCapability,
      "execute"
    >;
    const properties = Object.fromEntries(
      Object.entries(frozen.fields).map(([key, rule]) => [
        key,
        {
          ...rule,
          ...(rule.type === "string"
            ? { maxLength: rule.maxLength ?? 4000 }
            : {}),
        },
      ]),
    );
    const inputSchema = {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description: "Exact imported Project ID",
          maxLength: 100,
        },
        ...properties,
      },
      required: ["project_id", ...(frozen.required || [])],
      additionalProperties: false,
    };
    const entry = {
      definition: { ...frozen, execute },
      pluginId,
      inputSchema,
      digest: createHash("sha256")
        .update(JSON.stringify({ ...frozen, inputSchema }))
        .digest("hex"),
    };
    this.entries.set(id, entry);
    this.bridge.changed();
    return () => {
      if (this.entries.get(id) === entry) {
        this.entries.delete(id);
        this.bridge.changed();
      }
    };
  }
  list(all = false) {
    return [...this.entries]
      .filter(
        ([id, entry]) =>
          all ||
          (featureEnabled(this.bridge.config, "plugins") &&
            this.bridge.config.capabilityGrants?.[id] === entry.digest),
      )
      .map(([id, entry]) => ({
        id,
        pluginId: entry.pluginId,
        title: entry.definition.title,
        description: entry.definition.description,
        version: entry.definition.version,
        readOnly: true,
        enabled: this.bridge.config.capabilityGrants?.[id] === entry.digest,
        input_schema: entry.inputSchema,
      }));
  }
  enable(id: unknown, enabled: unknown): void {
    if (
      typeof id !== "string" ||
      typeof enabled !== "boolean" ||
      !this.entries.has(id)
    )
      throw new Error("Choose an installed Slack capability.");
    this.bridge.config.capabilityGrants ||= {};
    if (
      enabled &&
      !Object.hasOwn(this.bridge.config.capabilityGrants, id) &&
      Object.keys(this.bridge.config.capabilityGrants).length >= 250
    )
      throw new Error("Slack capability approval limit reached.");
    if (enabled)
      this.bridge.config.capabilityGrants[id] = this.entries.get(id)!.digest;
    else delete this.bridge.config.capabilityGrants[id];
    this.bridge.save();
  }
  async run(
    id: unknown,
    input: unknown,
    authorized: () => boolean,
  ): Promise<Record<string, unknown>> {
    const entry = typeof id === "string" ? this.entries.get(id) : undefined;
    const allowed = () =>
      !!entry &&
      featureEnabled(this.bridge.config, "plugins") &&
      authorized() &&
      this.entries.get(String(id)) === entry &&
      this.bridge.config.capabilityGrants?.[String(id)] === entry.digest;
    if (!allowed())
      return fail(
        "capability_unavailable",
        "Enable this installed capability in Zana for Slack first.",
      );
    let args: unknown;
    try {
      if (typeof input !== "string" || input.length > 8000) throw new Error();
      args = JSON.parse(input);
    } catch {
      return fail(
        "invalid_arguments",
        "Use a JSON object matching the capability schema.",
      );
    }
    const d = entry!.definition;
    if (
      !record(args) ||
      typeof args.project_id !== "string" ||
      !this.bridge.config.routes.some(
        (r) => r.projectId === args.project_id && r.model,
      ) ||
      (d.required || []).some((k) => !Object.hasOwn(args, k)) ||
      Object.entries(args).some(
        ([key, value]) =>
          key !== "project_id" &&
          (!Object.hasOwn(d.fields, key) ||
            typeof value !== d.fields[key].type ||
            (typeof value === "number" && !Number.isFinite(value)) ||
            (typeof value === "string" &&
              value.length > (d.fields[key].maxLength ?? 4000)) ||
            (d.fields[key].enum &&
              !d.fields[key].enum!.includes(value as any))),
      )
    )
      return fail(
        "invalid_arguments",
        "Use an imported Project and arguments matching the enabled capability schema.",
      );
    if (this.active.size >= 4)
      return fail(
        "busy",
        "Four plugin capabilities are already running. Try again shortly.",
      );
    const controller = new AbortController();
    this.active.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let executing = false;
    try {
      const projectId = args.project_id as string;
      const registered = await this.bridge.zcc.sdk.projects.list();
      if (!allowed() || !registered.some((p) => p.id === projectId))
        return fail(
          "capability_unavailable",
          "The connection, capability or Project changed.",
        );
      const { project_id, ...fields } = args;
      executing = true;
      const work = Promise.resolve()
        .then(() =>
          d.execute(fields, {
            projectId,
            slackUserId: this.bridge.config.owner!,
            teamId: this.bridge.config.identity!.team,
            signal: controller.signal,
          }),
        )
        .finally(() => this.active.delete(controller));
      const result = await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("timeout"));
          }, 8000);
        }),
      ]);
      if (
        !allowed() ||
        !this.bridge.config.routes.some(
          (r) => r.projectId === projectId && r.model,
        )
      )
        return fail(
          "capability_unavailable",
          "Access changed while the capability was running.",
        );
      const serialized = JSON.stringify(result);
      if (!record(result) || Buffer.byteLength(serialized) > 32_000)
        return fail(
          "invalid_result",
          "The plugin result must be a JSON object smaller than 32 KB.",
        );
      return { capability_id: id, result: JSON.parse(serialized) };
    } catch {
      return fail(
        "capability_failed",
        "The plugin could not return a result. Check it in Zana.",
      );
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (!executing) this.active.delete(controller);
    }
  }
  dispose() {
    for (const controller of this.active) controller.abort();
    this.entries.clear();
  }
}
