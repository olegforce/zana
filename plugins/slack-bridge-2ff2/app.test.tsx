// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@zana-ai/zcc-plugin-sdk/testing/app";
const app = await loadPluginApp(() => import("./app.tsx"), "slack-bridge-2ff2");
const mounts: { unmount(): void }[] = [];
const empty = {
  directSetup: true,
  connection: "Disconnected",
  config: { routes: [], enabled: false },
  projects: [{ id: "p1", name: "My Project" }],
  hosts: [{ id: "h1", name: "My Mac" }],
  providers: [{ id: "codex", name: "Codex" }],
  requests: [],
  bindings: [],
  deliveries: [],
};
function render(
  data: any = empty,
  handlers: Record<string, (a: any) => unknown> = {},
  subPath = "",
) {
  (globalThis as any).__ZCC_PLUGIN_HOST__ = {
    getSettings: vi.fn(async () => ({ values: { appId: "A123456" } })),
    setSettings: vi.fn(async () => {}),
  };
  window.history.replaceState(
    null,
    "",
    `/extensions/plugins/slack-bridge-2ff2?view=installed${subPath ? `&setup=${subPath}` : ""}#plugin-configure`,
  );
  const mounted = renderSlot(
    app.settingsSections[0]!,
    { pluginId: "slack-bridge-2ff2" },
    { rpc: { snapshot: () => data, ...handlers } },
  );
  mounts.push(mounted);
  return mounted;
}
afterEach(() => {
  for (const mounted of mounts.splice(0)) mounted.unmount();
  cleanup();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});
describe("Zana for Slack plugin settings", () => {
  it("saves the default for unmapped mentions from connected Projects", async () => {
    const setDefault = vi.fn(async () => null);
    const s = render(
      {
        ...empty,
        connection: "Connected",
        config: {
          enabled: true,
          owner: "U123456",
          routes: [
            {
              channel: "C123456",
              projectId: "p1",
              name: "demo",
              model: "demo-model",
            },
          ],
        },
      },
      { setMentionDefault: setDefault },
    );
    const select = await s.findByLabelText("Default Project for mentions");
    fireEvent.change(select, { target: { value: "p1" } });
    await waitFor(() =>
      expect(setDefault).toHaveBeenCalledWith({ projectId: "p1" }),
    );
    expect(s.getByText("Mention default saved.")).toBeTruthy();
  });
  it("keeps all controls on its plugin settings page with no sidebar panel", () => {
    expect(app.navPanels).toHaveLength(0);
    expect(app.settingsSections.map((s) => s.id)).toEqual(["connection"]);
  });
  it("restores the setup link after startup and cancels the pending handoff on unload", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const initial = `${window.location.origin}/plugins/slack-bridge-2ff2/main/connect`;
    Object.defineProperty(window.performance, "getEntriesByType", {
      configurable: true,
      value: vi.fn(() => [{ name: initial }]),
    });
    try {
      window.history.replaceState(null, "", "/");
      const mount = app.contentScripts[0]!.mount;
      const dispose = await mount({
        pluginId: "slack-bridge-2ff2",
        generation: 1,
        signal: controller.signal,
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(window.location.pathname).toBe(
        "/extensions/plugins/slack-bridge-2ff2",
      );
      expect(window.location.search).toBe("?view=installed&setup=connect");
      if (typeof dispose === "function") await dispose();
      window.history.replaceState(null, "", "/");
      const cancel = await mount({
        pluginId: "slack-bridge-2ff2",
        generation: 1,
        signal: controller.signal,
      });
      if (typeof cancel === "function") await cancel();
      await vi.advanceTimersByTimeAsync(100);
      expect(window.location.pathname).toBe("/");
      await mount({
        pluginId: "slack-bridge-2ff2",
        generation: 1,
        signal: controller.signal,
      });
      controller.abort();
      await vi.advanceTimersByTimeAsync(100);
      expect(window.location.pathname).toBe("/");
    } finally {
      vi.useRealTimers();
      window.history.replaceState(null, "", "/");
    }
  });
  it("opens connection settings from the Slack setup link and focuses the activation code", async () => {
    const s = render(
      {
        ...empty,
        config: {
          enabled: true,
          owner: "U123456",
          routes: [{ channel: "C123456", projectId: "p1", name: "demo" }],
        },
      },
      {},
      "connect",
    );
    await s.findByLabelText("Activation code");
    await waitFor(() =>
      expect(document.activeElement).toBe(s.getByLabelText("Activation code")),
    );
    expect(s.getByText("Connect your Slack account")).toBeTruthy();
    expect(s.getByText("Connected Projects")).toBeTruthy();
    expect(s.inspection.rpcCalls.some((c) => c.method === "addRoute")).toBe(
      false,
    );
    expect(s.queryByLabelText("Project")).toBeNull();
  });
  it("prepares a local sample, saves HTTPS setup and clearly disables the website", async () => {
    const data = {
      ...empty,
      embed: {
        origin: "",
        port: 8792,
        listening: false,
        error: "",
        lastPresented: 0,
      },
    };
    const s = render(data, {
      previewEmbed: () => ({ url: "http://127.0.0.1:8792/demo" }),
      configureEmbed: ({ origin, port }) => {
        data.embed = {
          origin,
          port,
          listening: !!origin,
          error: "",
          lastPresented: Date.now(),
        };
      },
    });
    await s.findByText("Slack UI surfaces");
    fireEvent.click(s.getByText("Prepare local preview"));
    expect(
      (await s.findByText("Open sample task website ↗")).getAttribute("href"),
    ).toBe("http://127.0.0.1:8792/demo");
    fireEvent.click(s.getByText("Set up the Slack website"));
    fireEvent.change(s.getByLabelText("Public HTTPS address"), {
      target: { value: "https://tasks.example.com" },
    });
    fireEvent.change(s.getByLabelText("Local task port"), {
      target: { value: "8999" },
    });
    fireEvent.click(s.getByText("Save website setup"));
    await s.findByText(/Website setup saved/);
    expect(s.inspection.rpcCalls).toContainEqual(
      expect.objectContaining({
        method: "configureEmbed",
        input: { origin: "https://tasks.example.com", port: 8999 },
      }),
    );
    await s.findByText(
      /HTTPS reachability and Slack display still need verification/,
    );
    fireEvent.click(s.getByText("Disable task website"));
    await s.findByText(
      "Task website disabled. Existing access links have ended.",
    );
    expect(s.queryByText("Open sample task website ↗")).toBeNull();
  });
  it("shows empty setup and safely stores secrets through settings", async () => {
    const data = { ...empty, config: { ...empty.config } };
    const s = render(data, {
      connect: () => {
        data.config.enabled = true;
        data.connection = "Connected";
      },
      disconnect: () => {
        data.config.enabled = false;
        data.connection = "Disconnected";
      },
    });
    await s.findByText("No requests received yet.");
    expect(s.getByLabelText("Bot token").getAttribute("type")).toBe("password");
    fireEvent.change(s.getByLabelText("App-level token"), {
      target: { value: "xapp-test" },
    });
    fireEvent.change(s.getByLabelText("Bot token"), {
      target: { value: "xoxb-test" },
    });
    fireEvent.click(s.getByText("Save credentials"));
    await s.findByText("Credentials saved. Connect when ready.");
    expect(
      (globalThis as any).__ZCC_PLUGIN_HOST__.setSettings,
    ).toHaveBeenCalledWith("slack-bridge-2ff2", {
      appId: "A123456",
      appToken: "xapp-test",
      botToken: "xoxb-test",
    });
    expect((s.getByLabelText("Bot token") as HTMLInputElement).value).toBe("");
    fireEvent.click(s.getByText("Connect"));
    await waitFor(() =>
      expect(s.inspection.rpcCalls.some((c) => c.method === "connect")).toBe(
        true,
      ),
    );
    await act(async () => {});
    fireEvent.click(s.getByText("Disconnect"));
    await s.findByText("Disconnected. Existing agents remain in Zana.");
  });
  it("pairs an owner and presents errors without discarding setup", async () => {
    const s = render(empty, {
      pair: () => ({ code: "one-time", expires: Date.now() + 60000 }),
      connect: () => {
        throw new Error("Invalid credentials");
      },
    });
    await s.findByText("No Slack conversations yet.");
    fireEvent.change(s.getByLabelText("Your Slack member ID"), {
      target: { value: "U123456" },
    });
    fireEvent.click(s.getByText("Generate pairing code"));
    await s.findByText("@Zana link one-time");
    fireEvent.click(s.getByText("Connect"));
    await s.findByRole("alert");
    expect(s.getByRole("alert").textContent).toContain("Invalid credentials");
  });
  it("maps channels, navigates, stops, reviews and publishes only the composed reply", async () => {
    const b = {
      key: "k1",
      threadId: "th1",
      projectId: "p1",
      channel: "C123456",
      root: "1234567890.000001",
      state: "running",
      active: "r1",
      team: "T123456",
      updated: Date.now(),
    };
    const r = {
      channel: "C123456",
      name: "agents",
      projectId: "p1",
      hostId: "h1",
      providerId: "codex",
      summaries: true,
    };
    const data = {
      ...empty,
      connection: "Connected",
      config: { owner: "U123456", identity: { team: "T123456" }, routes: [r] },
      bindings: [b],
      requests: [
        {
          id: "r1",
          state: "needs-review",
          text: "review tests",
          note: "Inspect Zana",
          created: Date.now(),
        },
      ],
      deliveries: [
        {
          id: "d1",
          state: "uncertain",
          text: "A reply",
          channel: "C123456",
          note: "Check Slack",
        },
      ],
    };
    const s = render(data, {
      models: () => [{ id: "demo-model", name: "demo-model" }],
      addRoute: () => {},
      removeRoute: () => {},
      stop: () => {},
      publish: () => {},
      resolve: () => {},
      resolveDelivery: () => {},
      resetOwner: () => {},
    });
    await s.findByText("review tests");
    fireEvent.click(s.getByText("Connect another Project"));
    fireEvent.change(s.getByLabelText("Slack channel ID"), {
      target: { value: "C123456" },
    });
    fireEvent.change(s.getByLabelText("Project"), { target: { value: "p1" } });
    fireEvent.change(s.getByLabelText("Machine"), { target: { value: "h1" } });
    fireEvent.change(s.getByLabelText("Agent provider"), {
      target: { value: "codex" },
    });
    await s.findByText("demo-model");
    fireEvent.change(s.getByLabelText("Model"), {
      target: { value: "demo-model" },
    });
    fireEvent.click(s.getByLabelText("Concise answers in Slack (recommended)"));
    fireEvent.click(s.getByText("Save channel mapping"));
    await s.findByText("Channel saved. Mention @Zana with a task to try it.");
    expect(s.inspection.rpcCalls).toContainEqual({
      method: "addRoute",
      input: {
        channel: "C123456",
        projectId: "p1",
        hostId: "h1",
        providerId: "codex",
        model: "demo-model",
        summaries: true,
      },
    });
    fireEvent.click(s.getByText("Open in Zana"));
    expect(s.inspection.navigateCalls).toContainEqual({
      method: "toThread",
      threadId: "th1",
    });
    fireEvent.click(s.getByText("Stop agent"));
    await waitFor(() =>
      expect(s.inspection.rpcCalls.some((c) => c.method === "stop")).toBe(true),
    );
    await act(async () => {});
    fireEvent.click(s.getByText("Write Slack reply"));
    fireEvent.change(s.getByLabelText("Slack reply"), {
      target: { value: "Reviewed result" },
    });
    fireEvent.click(s.getByText("Send this reply to Slack"));
    await s.findByText(
      "Reply queued. Check the delivery log for confirmation.",
    );
    expect(s.inspection.rpcCalls).toContainEqual({
      method: "publish",
      input: { threadId: "th1", projectId: "p1", text: "Reviewed result" },
    });
    fireEvent.click(s.getByText("Write Slack reply"));
    fireEvent.click(s.getByText("Cancel"));
    fireEvent.click(s.getByText("I inspected Zana — dismiss this request"));
    await s.findByText("Marked reviewed. This request will not be retried.");
    fireEvent.click(s.getByText("Remove mapping"));
    await act(async () => {});
    fireEvent.click(s.getByText("I checked Slack — mark reviewed"));
    await s.findByText("Delivery marked reviewed. No retry was sent.");
    fireEvent.click(s.getByText("Connection settings"));
    fireEvent.click(s.getByText("Unlink owner and clear mappings"));
    fireEvent.click(s.getByText("Confirm unlink"));
    await s.findByText(
      "Owner and channel mappings cleared. Reconnect to pair again.",
    );
    act(() => s.emitRealtime("bridge.changed"));
    expect(
      s.inspection.rpcCalls.filter((c) => c.method === "snapshot").length,
    ).toBeGreaterThan(2);
  });
  it("selects Projects without importing the rest and displays registered capabilities", async () => {
    const s = render(
      {
        ...empty,
        connection: "Connected",
        projects: [...empty.projects, { id: "p2", name: "Leave local" }],
        config: {
          enabled: true,
          owner: "U123456",
          routes: [],
          projectSync: {
            enabled: true,
            projectIds: [],
            hostId: "h1",
            providerId: "codex",
            model: "demo-model",
            summaries: false,
          },
        },
        capabilities: {
          builtins: [],
          commands: [],
          extensible: true,
          plugins: [
            {
              id: "demo.read",
              title: "Read ticket",
              description: "Read a ticket",
              pluginId: "demo",
              enabled: false,
            },
          ],
        },
      },
      {
        models: () => [{ id: "demo-model", name: "Demo model" }],
        importProjects: () => ({}),
        enableCapability: () => ({}),
      },
    );
    const button = await s.findByRole("button", { name: "Import selected" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(s.getByLabelText("Import My Project"));
    fireEvent.click(s.getByRole("button", { name: "Import selected (1)" }));
    await s.findByText(/Selected Projects submitted/);
    expect(s.inspection.rpcCalls).toContainEqual({
      method: "importProjects",
      input: { projectIds: ["p1"] },
    });
    expect(
      s.inspection.rpcCalls.some(
        (call) => call.method === "configureProjectSync",
      ),
    ).toBe(false);
    fireEvent.click(s.getByRole("switch", { name: "Enable Read ticket" }));
    await s.findByText("Plugin capability enabled for Slack.");
    expect(s.inspection.rpcCalls).toContainEqual({
      method: "enableCapability",
      input: { id: "demo.read", enabled: true },
    });
    fireEvent.change(s.getByLabelText("Search Projects"), {
      target: { value: "no match" },
    });
    expect(s.getByText("No Projects match your search.")).toBeTruthy();
  });
  it("saves defaults with proper selectors without creating channels", async () => {
    const s = render(
      {
        ...empty,
        connection: "Connected",
        config: { enabled: true, owner: "U123456", routes: [] },
      },
      {
        models: () => [{ id: "demo-model", name: "Demo model" }],
        configureProjectSync: () => ({}),
      },
    );
    fireEvent.click(await s.findByRole("button", { name: /Default machine/ }));
    fireEvent.click(s.getByRole("option", { name: "My Mac" }));
    fireEvent.click(s.getByRole("button", { name: /Default provider/ }));
    fireEvent.click(s.getByRole("option", { name: "Codex" }));
    await waitFor(() =>
      expect(
        (s.getByRole("button", { name: /Default model/ }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(s.getByRole("button", { name: /Default model/ }));
    fireEvent.click(s.getByRole("option", { name: "Demo model" }));
    fireEvent.change(s.getByPlaceholderText("Example: team"), {
      target: { value: "team" },
    });
    fireEvent.click(s.getByLabelText(/Concise answers/));
    fireEvent.click(s.getByRole("button", { name: "Save import defaults" }));
    await s.findByText(/Import defaults saved/);
    expect(s.inspection.rpcCalls).toContainEqual({
      method: "configureProjectSync",
      input: {
        enabled: true,
        channelPrefix: "team",
        hostId: "h1",
        providerId: "codex",
        model: "demo-model",
        summaries: true,
        allowSlackImport: true,
      },
    });
    expect(
      s.inspection.rpcCalls.some((call) => call.method === "importProjects"),
    ).toBe(false);
  });
  it("retries selected imports after a Slack error", async () => {
    const s = render(
      {
        ...empty,
        connection: "Connected",
        projectSync: { state: "error", error: "Slack needs groups:write." },
        config: {
          enabled: true,
          owner: "U123456",
          routes: [],
          projectSync: {
            enabled: true,
            hostId: "h1",
            providerId: "codex",
            model: "demo-model",
            summaries: false,
          },
        },
      },
      { syncProjects: () => ({}), models: () => [] },
    );
    expect((await s.findByRole("alert")).textContent).toContain("groups:write");
    fireEvent.click(s.getByRole("button", { name: "Retry selected imports" }));
    await s.findByText("Selected imports retried.");
    expect(s.inspection.rpcCalls).toContainEqual({
      method: "syncProjects",
      input: null,
    });
  });
  it("discards stale model discovery and keeps failed model selection disabled", async () => {
    let resolveOld!: (value: unknown) => void;
    const old = new Promise((resolve) => {
      resolveOld = resolve;
    });
    const s = render(
      {
        ...empty,
        connection: "Connected",
        config: { enabled: true, owner: "U123456", routes: [] },
        hosts: [...empty.hosts, { id: "h2", name: "Other Mac" }],
      },
      {
        models: ({ hostId }) =>
          hostId === "h1" ? old : { bridgeError: "Machine offline" },
      },
    );
    await s.findByText("No Slack conversations yet.");
    fireEvent.click(
      s.getByRole("button", { name: "Connect an existing Slack channel" }),
    );
    fireEvent.change(s.getByLabelText("Machine"), { target: { value: "h1" } });
    fireEvent.change(s.getByLabelText("Agent provider"), {
      target: { value: "codex" },
    });
    await s.findByText("Loading models…");
    fireEvent.change(s.getByLabelText("Machine"), { target: { value: "h2" } });
    await s.findByText("Machine offline");
    await act(async () => resolveOld([{ id: "stale", name: "Stale model" }]));
    expect(s.queryByText("Stale model")).toBeNull();
    expect((s.getByLabelText("Model") as HTMLSelectElement).disabled).toBe(
      true,
    );
    expect(
      (s.getByText("Save channel mapping") as HTMLButtonElement).disabled,
    ).toBe(true);
  });
  it("opens on the dashboard, prefills edits, and leaves sharing unchanged", async () => {
    const r = {
      channel: "C123456",
      name: "demo",
      projectId: "p1",
      hostId: "h1",
      providerId: "codex",
      model: "demo-model",
      summaries: true,
    };
    const s = render(
      {
        ...empty,
        connection: "Connected",
        config: {
          enabled: true,
          owner: "U123456",
          ownerName: "Guillaume",
          workspaceName: "Zana",
          identity: { team: "T123456" },
          routes: [r],
        },
      },
      {
        models: () => [{ id: "demo-model", name: "demo-model" }],
        channels: () => [{ id: "C123456", name: "demo" }],
        addRoute: () => {},
        testChannel: () => {},
      },
    );
    await s.findByText("Zana · Guillaume");
    expect(s.queryByLabelText("Bot token")).toBeNull();
    expect(s.queryByLabelText("Model")).toBeNull();
    expect(
      s.getByText("Diagnostics · Requests and delivery").closest("details")
        ?.open,
    ).toBe(false);
    fireEvent.click(s.getByText("Edit #demo"));
    await waitFor(() =>
      expect((s.getByLabelText("Model") as HTMLSelectElement).value).toBe(
        "demo-model",
      ),
    );
    expect(
      (
        s.getByLabelText(
          "Concise answers in Slack (recommended)",
        ) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect((s.getByLabelText("Project") as HTMLSelectElement).value).toBe("p1");
    fireEvent.click(s.getByText("Find joined channels"));
    await act(async () => {});
    fireEvent.click(s.getByText("Reload models"));
    await act(async () => {});
    fireEvent.click(s.getByText("Save channel mapping"));
    await s.findByText("Channel saved. Mention @Zana with a task to try it.");
    expect(s.inspection.rpcCalls).toContainEqual({
      method: "addRoute",
      input: {
        channel: r.channel,
        projectId: r.projectId,
        hostId: r.hostId,
        providerId: r.providerId,
        model: r.model,
        summaries: true,
      },
    });
    fireEvent.click(s.getByText("Edit #demo"));
    await act(async () => {});
    fireEvent.click(s.getByText("Cancel editing"));
    fireEvent.click(s.getByText("Send connection test"));
    await s.findByText(
      "Test message queued. Check Slack, then mention the bot with a task to verify the full journey.",
    );
    fireEvent.click(s.getByText("Connection settings"));
    fireEvent.click(s.getByText("Unlink owner and clear mappings"));
    fireEvent.click(s.getByText("Keep connection"));
    expect(s.inspection.rpcCalls.some((c) => c.method === "resetOwner")).toBe(
      false,
    );
    fireEvent.click(s.getByText("Close settings"));
    expect(s.queryByLabelText("Bot token")).toBeNull();
  });
  it("hides deleted controls, shows task titles, and separates muting from stopping", async () => {
    const b = {
      key: "k",
      team: "T123456",
      channel: "C123456",
      root: "1234567890.000001",
      threadId: "th1",
      projectId: "p1",
      title: "Review login",
      state: "deleted",
      updated: Date.now() - 3600000,
    };
    const s = render({ ...empty, bindings: [b] }, {});
    await s.findByText("Show archived and deleted conversations");
    expect(s.queryByText("Review login")).toBeNull();
    fireEvent.click(
      s.getByLabelText("Show archived and deleted conversations"),
    );
    await s.findByText("Review login");
    expect(s.queryByText("Open in Zana")).toBeNull();
    expect(s.queryByText("Stop agent")).toBeNull();
    expect(s.getByText("View in Slack").getAttribute("href")).toContain(
      "?thread_ts=1234567890.000001&cid=C123456",
    );
    expect(
      s.getByText("Start a new top-level Slack mention for another agent."),
    ).toBeTruthy();
  });
  it("shows waiting questions and sends an explicit mute without stopping", async () => {
    const b = {
      key: "k",
      team: "T123456",
      channel: "C123456",
      root: "1234567890.000001",
      threadId: "th1",
      projectId: "p1",
      title: "Review login",
      state: "running",
      active: "r",
      needsAttention: true,
      updated: Date.now(),
    };
    const s = render({ ...empty, bindings: [b] }, { mute: () => {} });
    await s.findByText("Needs attention in Zana");
    fireEvent.click(s.getByText("Mute updates"));
    await s.findByText("Updates muted. The agent continues working.");
    expect(s.inspection.rpcCalls).toContainEqual({
      method: "mute",
      input: { key: "k", muted: true },
    });
    expect(s.inspection.rpcCalls.some((c) => c.method === "stop")).toBe(false);
  });
  it("renders snapshot failure accessibly", async () => {
    const s = render(empty, {
      snapshot: () => {
        throw new Error("offline");
      },
    });
    await s.findByRole("alert");
  });
});

it("enables the hosted task panel with one control and hides direct hosting inputs", async () => {
  const data: any = {
    ...empty,
    connect: { linked: true, origin: "https://example.com", computer: "Mac" },
    embed: { viaConnect: false },
  };
  const save = vi.fn(({ enabled }) => {
    data.embed = {
      viaConnect: enabled,
      origin: enabled ? "https://example.com" : "",
    };
  });
  const s = render(data, { configureHostedEmbed: save });
  const toggle = await s.findByLabelText("Enable custom web panels");
  expect(s.queryByLabelText("Local task port")).toBeNull();
  fireEvent.click(toggle);
  await waitFor(() => expect(save).toHaveBeenCalledWith({ enabled: true }));
  await s.findByText(/Enabled through your Zana connection/);
  fireEvent.click(s.getByLabelText("Enable custom web panels"));
  await waitFor(() =>
    expect(save).toHaveBeenLastCalledWith({ enabled: false }),
  );
});

it("starts with token-free account setup and opts into a separately managed Slack app", async () => {
  const data: any = { ...empty, directSetup: false };
  const s = render(data, {
    enableDirectSetup: () => {
      data.directSetup = true;
    },
  });
  await s.findByLabelText("Activation code");
  expect(s.queryByLabelText("Slack app ID")).toBeNull();
  expect(s.queryByLabelText("Bot token")).toBeNull();
  expect(s.queryByLabelText("Your Slack member ID")).toBeNull();
  expect(s.queryByText("Prepare local preview")).toBeNull();
  fireEvent.click(s.getByText("Advanced: use your own Slack app"));
  fireEvent.click(s.getByRole("button", { name: "Set up my own Slack app" }));
  await s.findByLabelText("Bot token");
  expect(
    s.inspection.rpcCalls.some((c) => c.method === "enableDirectSetup"),
  ).toBe(true);
});
it("keeps linked settings free of credentials, manual pairing, ports and developer previews", async () => {
  const s = render({
    ...empty,
    directSetup: false,
    connect: {
      linked: true,
      computer: "My Mac",
      origin: "https://zana-ide.com",
      owner: "U123456",
    },
    config: { enabled: true, owner: "U123456", routes: [] },
  });
  await s.findByText("Connect your Slack account");
  for (const label of [
    "Slack app ID",
    "App-level token",
    "Bot token",
    "Your Slack member ID",
    "Activation code",
    "Connect service",
  ])
    expect(s.queryByLabelText(label)).toBeNull();
  expect(s.queryByText("Prepare local preview")).toBeNull();
  expect(s.queryByText("Unlink owner and clear mappings")).toBeNull();
  expect(s.getByLabelText("Enable custom web panels")).toBeTruthy();
});

it("offers an explicit rich-results opt-in and reports a failed save without changing the checkbox", async () => {
  const data = {
    ...empty,
    config: { ...empty.config, richResultsEnabled: false },
  };
  const save = vi.fn((a: any) => {
    data.config.richResultsEnabled = a.enabled;
    return null;
  });
  const s = render(data, { setRichResults: save });
  const checkbox = (await s.findByLabelText(
    "Share rich results",
  )) as HTMLInputElement;
  expect(checkbox.checked).toBe(false);
  fireEvent.click(checkbox);
  await waitFor(() => expect(save).toHaveBeenCalledWith({ enabled: true }));
  await waitFor(() => expect(checkbox.checked).toBe(true));
  fireEvent.click(checkbox);
  await waitFor(() => expect(checkbox.checked).toBe(false));
  s.unmount();
  const failed = render(data, {
    setRichResults: () => ({ bridgeError: "Could not save sharing" }),
  });
  fireEvent.click(await failed.findByLabelText("Share rich results"));
  await failed.findByText("Could not save sharing");
  expect(
    (failed.getByLabelText("Share rich results") as HTMLInputElement).checked,
  ).toBe(false);
});
it("saves each optional Slack surface and displays local export diagnostics", async () => {
  const data = {
    ...empty,
    config: { ...empty.config },
    surfaceLog: [
      {
        id: "canvas",
        title: "Release snapshot",
        state: "published",
        note: "Shared with the owner",
        url: "https://app.slack.com/docs/T123456/F123456",
      },
    ],
  };
  const save = vi.fn(({ surface, enabled }) => {
    (data.config as any)[surface] = enabled;
    return null;
  });
  const s = render(data, { setSurface: save });
  for (const [surface, label] of [
    ["agentChatEnabled", "Private agent chat"],
    ["inboxEnabled", "Read report inbox"],
    ["questionsEnabled", "Question forms in Slack"],
    ["canvasEnabled", "Publish shared answers to Canvas"],
  ]) {
    const checkbox = await s.findByLabelText(label);
    expect((checkbox as HTMLInputElement).checked).toBe(false);
    fireEvent.click(checkbox);
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({ surface, enabled: true }),
    );
  }
  expect(
    s.getByRole("link", { name: "Open Canvas" }).getAttribute("href"),
  ).toContain("F123456");
});

it("explains when the installed core needs an update for conversational reports", async () => {
  const screen = render({ ...empty, conversationalChatReady: false });
  await screen.findByText(
    /Update Zana to use conversational Project selection/,
  );
});
