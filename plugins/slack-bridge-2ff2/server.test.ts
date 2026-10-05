import { describe, expect, it, vi } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import plugin from "./server.ts";
import { setup } from "./test/helpers.js";
describe("plugin registration", () => {
  it("registers local Connect activation, authenticated ingress and revocation without exposing the grant", async () => {
    const f = setup();
    f.store.configure({ enabled: false, routes: [] });
    const define = vi.spyOn(f.zcc.settings, "define");
    const routes = new Map<string, any>();
    f.zcc.http.route = (_method, path, handler) => {
      routes.set(path, handler);
    };
    const key = "k".repeat(43),
      linkId = "00000000-0000-4000-8000-000000000001";
    const identity = { team: "T123456", app: "A123456", bot: "U999999" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, options: any) => {
        if (String(url).includes("/redeem/"))
          return Response.json({
            linkId,
            credential: `${linkId}.${key}`,
            identity,
            owner: "U123456",
            computer: "My Mac",
          });
        if (String(url).includes("/call/")) {
          const p = JSON.parse(options.body);
          return Response.json(await f.call(p.method, p.args));
        }
        return Response.json({ active: true });
      }),
    );
    try {
      await plugin(f.zcc);
      const h = f.harness as any;
      expect(define).toHaveBeenLastCalledWith({});
      expect((await h.callRpc("snapshot")).directSetup).toBe(false);
      expect(await h.callRpc("enableDirectSetup")).toBeNull();
      expect((await h.callRpc("snapshot")).directSetup).toBe(true);
      expect(define.mock.calls.at(-1)?.[0]).toMatchObject({
        appToken: { secret: true },
        botToken: { secret: true },
      });
      expect(await routes.get("/connect")({ body: {} })).toMatchObject({
        status: 401,
      });
      await expect(
        h.callRpc("linkConnect", {
          origin: "https://example.com",
          code: "c".repeat(43),
        }),
      ).resolves.toBeNull();
      const snapshot = await h.callRpc("snapshot");
      expect(snapshot.connect).toMatchObject({
        linked: true,
        computer: "My Mac",
      });
      expect(JSON.stringify(snapshot)).not.toContain(key);
      expect(snapshot.directSetup).toBe(false);
      expect(define).toHaveBeenLastCalledWith({});
      expect(await h.callRpc("enableDirectSetup")).toMatchObject({
        bridgeError: expect.stringContaining("Unlink"),
      });
      h.setSettings({ appId: "A234567" });
      expect((await h.callRpc("snapshot")).connection).toBe("Connected");
      expect(
        await h.callRpc("configureHostedEmbed", { enabled: true }),
      ).toBeNull();
      expect((await h.callRpc("snapshot")).embed).toMatchObject({
        viaConnect: true,
        listening: true,
      });
      expect(
        await h.callRpc("configureHostedEmbed", { enabled: false }),
      ).toBeNull();
      const signed = {
        v: 1,
        linkId,
        timestamp: Date.now(),
        nonce: randomBytes(32).toString("base64url"),
        body: JSON.stringify({ kind: "probe" }),
      };
      expect(
        await routes.get("/connect")({
          body: {
            ...signed,
            signature: createHmac("sha256", key)
              .update(JSON.stringify(signed))
              .digest("hex"),
          },
        }),
      ).toMatchObject({ json: { linkId } });
      expect(await h.callRpc("resetOwner")).toMatchObject({
        bridgeError: "Unlink Zana Connect first.",
      });
      await h.callRpc("unlinkConnect");
      expect((await h.callRpc("snapshot")).connect.linked).toBe(false);
      expect(define).toHaveBeenLastCalledWith({});
      expect(await f.zcc.storage.kv.get("directSetup")).toBe(false);
    } finally {
      await (f.harness as any).dispose();
      await f.close();
      vi.unstubAllGlobals();
    }
  });
  it("registers secrets, validated RPC, scoped publishing and read-only CLI; disposes cleanly", async () => {
    const f = setup();
    await plugin(f.zcc);
    const h = f.harness as any;
    const snap = await h.callRpc("snapshot");
    expect(snap.connection).toBe("Disconnected");
    expect(snap.capabilities.features).toHaveLength(7);
    await h.callRpc("setSlackAccess", { id: "launch", enabled: false });
    expect(
      (await h.callRpc("snapshot")).capabilities.features.find(
        (f: any) => f.id === "launch",
      ).enabled,
    ).toBe(false);
    await expect(
      h.callRpc("setSlackAccess", { id: "bad", enabled: true }),
    ).resolves.toMatchObject({ bridgeError: expect.any(String) });

    await expect(h.callRpc("connect")).resolves.toEqual({
      bridgeError: expect.stringContaining("Connection failed"),
    });
    await expect(h.callRpc("pair", { user: "bad" })).resolves.toEqual({
      bridgeError: expect.any(String),
    });
    for (const [method, args] of [
      ["channels", {}],
      ["dismissHomeRequest", { id: "missing" }],
      ["testChannel", { channel: "none" }],
      ["mute", { key: "none", muted: true }],
    ] as const)
      await expect(h.callRpc(method, args)).resolves.toEqual({
        bridgeError: expect.any(String),
      });
    await expect(h.callRpc("addRoute", {})).resolves.toEqual({
      bridgeError: expect.any(String),
    });
    await expect(h.callRpc("publish", {})).resolves.toEqual({
      bridgeError: expect.any(String),
    });
    await expect(h.callRpc("stop", { key: "none" })).resolves.toEqual({
      bridgeError: expect.any(String),
    });
    await expect(h.callRpc("resolve", { id: "none" })).resolves.toEqual({
      bridgeError: expect.any(String),
    });
    expect(
      await h.callRpc("models", { hostId: "h1", providerId: "codex" }),
    ).toEqual([{ id: "demo-model", name: "demo-model" }]);
    await h.callRpc("refreshHome");
    await expect(
      h.callRpc("setMentionDefault", { projectId: "unknown" }),
    ).resolves.toEqual({ bridgeError: expect.any(String) });
    await expect(
      h.callRpc("configureEmbed", { origin: "http://localhost", port: 8792 }),
    ).resolves.toEqual({ bridgeError: expect.any(String) });
    await h.callRpc("configureEmbed", { origin: "", port: 8792 });
    expect(snap.embed.origin).toBe("");
    const status = await h.runCli(["status"]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("Disconnected");
    expect((await h.runCli(["bad"])).exitCode).toBe(1);
    expect(h.agentTools[0].name).toBe("slack_bridge_publish");
    expect(h.agentTools[1].name).toBe("slack_bridge_ask");
    expect(() =>
      h.agentTools[1].execute(
        { questions: [] },
        { threadId: "other", projectId: "p1" },
      ),
    ).toThrow();
    expect(
      await h.callRpc("setSurface", { surface: "invalid", enabled: true }),
    ).toHaveProperty("bridgeError");
    expect(
      await h.callRpc("setSurface", {
        surface: "canvasEnabled",
        enabled: "true",
      }),
    ).toHaveProperty("bridgeError");
    for (const surface of [
      "agentChatEnabled",
      "questionsEnabled",
      "canvasEnabled",
    ]) {
      expect(
        await h.callRpc("setSurface", { surface, enabled: true }),
      ).toBeNull();
      expect((await h.callRpc("snapshot")).config[surface]).toBe(true);
    }
    await expect(
      h.agentTools[0].execute(
        { text: "hi" },
        { threadId: "other", projectId: "p1" },
      ),
    ).rejects.toThrow();
    expect(await h.agentConfigurers[0]({ threadId: "other" })).toBeUndefined();
    h.setSettings({ appId: "A123456" });
    await h.callRpc("removeRoute", { channel: "C123456" });
    await h.callRpc("resetOwner");
    await h.callRpc("disconnect");
    await h.dispose();
    await f.close();
  });
});

it("provides the plugin capability service and local RPC gates", async () => {
  const f = setup();
  let provided: any;
  (f.zcc as any).services = {
    provide(value: any) {
      provided = value;
    },
  };
  try {
    await plugin(f.zcc);
    expect(provided.register).toBeTypeOf("function");
    const dispose = provided.register("fixture", {
      id: "inspect",
      title: "Fixture",
      description: "Read fixture",
      version: 1,
      readOnly: true,
      fields: {},
      execute: async () => ({ ok: true }),
    });
    expect(
      (await (f.harness as any).callRpc("snapshot")).capabilities,
    ).toMatchObject({
      extensible: true,
      plugins: [{ id: "fixture.inspect", enabled: false }],
    });
    await (f.harness as any).callRpc("enableCapability", {
      id: "fixture.inspect",
      enabled: true,
    });
    expect(
      (await (f.harness as any).callRpc("snapshot")).capabilities.plugins[0]
        .enabled,
    ).toBe(true);
    expect(
      await (f.harness as any).callRpc("importProjects", {
        projectIds: ["p1"],
      }),
    ).toHaveProperty("bridgeError");
    dispose();
  } finally {
    await (f.harness as any).dispose();
    await f.close();
  }
});

it("does not reactivate legacy app credentials after the operator chose the account connection", async () => {
  const f = setup();
  await f.zcc.storage.kv.set("directSetup", false);
  const define = vi.spyOn(f.zcc.settings, "define");
  try {
    await plugin(f.zcc);
    expect(define).toHaveBeenLastCalledWith({});
    expect((await (f.harness as any).callRpc("snapshot")).directSetup).toBe(
      false,
    );
  } finally {
    await (f.harness as any).dispose();
    await f.close();
  }
});

it("keeps Slack context when sharing is disabled, before binding, after revocation and for legacy sessions", async () => {
  const f = setup();
  f.store.configure({
    ...f.store.config(),
    enabled: false,
    routes: f.store.config().routes.map((r) => ({ ...r, summaries: true })),
  });
  try {
    await plugin(f.zcc);
    const h = f.harness as any;
    const configure = h.agentConfigurers[0];
    const context = {
      threadId: "legacy",
      projectId: "p1",
      pluginMetadata: { slackConversation: "conversation" },
    };
    const pending = await configure(context);
    expect(pending.tools).toEqual([]);
    expect(pending.instructions).toContain("cannot see Zana's desktop panels");
    expect(pending.instructions).toContain("Answer sharing is disabled");
    expect(
      (f.zcc.sdk.threads as any).updatePluginMetadata,
    ).toHaveBeenCalledWith({
      threadId: "legacy",
      set: { interactionSurface: { kind: "remote", label: "Slack" } },
    });
    f.store.put("binding", "conversation", {
      key: "conversation",
      threadId: "legacy",
      channel: "C123456",
      projectId: "p1",
      state: "idle",
      updated: Date.now(),
    } as any);
    expect((await configure(context)).tools).toEqual(["slack_bridge_publish"]);
    await h.callRpc("setSurface", {
      surface: "questionsEnabled",
      enabled: true,
    });
    expect((await configure(context)).tools).toEqual([
      "slack_bridge_publish",
      "slack_bridge_ask",
    ]);
    expect((await configure(context)).instructions).toContain(
      "Never use it for execution approval",
    );
    await h.callRpc("setSlackAccess", { id: "followups", enabled: false });
    expect((await configure(context)).tools).toEqual(["slack_bridge_publish"]);
    expect((await configure(context)).instructions).not.toContain(
      "Use slack_bridge_ask",
    );
    await h.callRpc("setSlackAccess", { id: "followups", enabled: true });
    await h.callRpc("setSlackAccess", { id: "answers", enabled: false });
    expect((await configure(context)).tools).toEqual([]);
    await h.callRpc("removeRoute", { channel: "C123456" });
    expect((await configure({ threadId: "legacy" })).instructions).toContain(
      "interacting through Slack",
    );
    expect(await configure({ threadId: "other" })).toBeUndefined();
  } finally {
    await (f.harness as any).dispose();
    await f.close();
  }
});

it("keeps rich results disabled by default and exposes the bounded report schema after opt-in", async () => {
  const f = setup();
  f.store.configure({
    ...f.store.config(),
    routes: f.store.config().routes.map((r) => ({ ...r, summaries: true })),
  });
  try {
    await plugin(f.zcc);
    const h = f.harness as any;
    expect(
      (await h.callRpc("snapshot")).config.richResultsEnabled,
    ).toBeUndefined();
    expect(
      await h.callRpc("setRichResults", { enabled: "true" }),
    ).toMatchObject({ bridgeError: expect.any(String) });
    expect(await h.callRpc("setRichResults", { enabled: true })).toBeNull();
    expect((await h.callRpc("snapshot")).config.richResultsEnabled).toBe(true);
    expect(
      h.agentTools[0].inputSchema.properties.result.additionalProperties,
    ).toBe(false);
    f.store.put("binding", "rich", {
      key: "rich",
      threadId: "rich-thread",
      channel: "C123456",
      projectId: "p1",
      state: "idle",
      updated: Date.now(),
    } as any);
    f.store.configure({
      ...f.store.config(),
      routes: f.store.config().routes.map((r) => ({ ...r, summaries: true })),
    });
    // RPC updates the in-memory bridge policy; changing just storage is insufficient.
    await h.callRpc("setRichResults", { enabled: true });
    const guidance = await h.agentConfigurers[0]({
      threadId: "rich-thread",
      projectId: "p1",
    });
    expect(guidance.instructions).toContain("not a live editable");
    expect(guidance.instructions).toContain("Rich results are enabled");
    expect(guidance.instructions).toContain("under 2000 characters");
    expect(guidance.instructions).toContain(
      "use a text field, never code or diff fields",
    );
    expect(guidance.instructions).toContain("limited to 2800 characters");
    await h.callRpc("setRichResults", { enabled: false });
    expect(
      (await h.agentConfigurers[0]({ threadId: "rich-thread" })).instructions,
    ).toContain("Rich results are disabled");
  } finally {
    await (f.harness as any).dispose();
    await f.close();
  }
});

it("requires the updated core before granting report-inbox access", async () => {
  const f = setup();
  try {
    await plugin(f.zcc);
    (f.zcc as any).sdk.assistant = undefined;
    await expect(
      f.harness.callRpc("setSurface", {
        surface: "inboxEnabled",
        enabled: true,
      }),
    ).resolves.toMatchObject({ bridgeError: expect.stringMatching(/Update Zana/) });
  } finally {
    await f.harness.dispose();
    await f.close();
  }
});
