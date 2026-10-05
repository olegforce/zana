// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { Picker, ProjectImports, CapabilitySettings } from "./imports-view.js";
import React from "react";
afterEach(cleanup);
const data = {
  connection: "Connected",
  config: {
    enabled: true,
    owner: "U123456",
    routes: [
      {
        projectId: "p1",
        channel: "C123456",
        name: "zana-one",
        hostId: "h1",
        providerId: "codex",
        model: "m1",
        summaries: false,
      },
    ],
    projectSync: {
      enabled: true,
      projectIds: ["p1", "p2"],
      hostId: "h1",
      providerId: "codex",
      model: "m1",
      summaries: false,
    },
  },
  projects: [
    { id: "p1", name: "One" },
    { id: "p2", name: "Two" },
  ],
  hosts: [{ id: "h1", name: "Mac" }],
  providers: [{ id: "codex", name: "Codex" }],
};
it("supports search, keyboard movement, escape and outside-click in pickers", () => {
  const change = vi.fn(),
    s = render(
      <Picker
        label="Machine"
        value="h1"
        options={[
          { id: "h1", name: "Mac" },
          { id: "h2", name: "Remote" },
        ]}
        onChange={change}
      />,
    );
  const trigger = s.getByRole("button", { name: "Machine Mac" });
  fireEvent.click(trigger);
  const search = s.getByLabelText("Search machine");
  fireEvent.keyDown(search, { key: "ArrowDown" });
  expect(document.activeElement).toBe(s.getByRole("option", { name: /Mac/ }));
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  expect(document.activeElement).toBe(
    s.getByRole("option", { name: "Remote" }),
  );
  fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
  expect(document.activeElement).toBe(s.getByRole("option", { name: /Mac/ }));
  fireEvent.change(search, { target: { value: "missing" } });
  expect(s.getByText("No matches")).toBeTruthy();
  fireEvent.keyDown(search, { key: "Escape" });
  expect(s.queryByRole("listbox")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  fireEvent.pointerDown(document.body);
  expect(s.queryByRole("listbox")).toBeNull();
});
it("filters imported Projects and shows pending/error progress without selecting them again", async () => {
  const rpc = { call: vi.fn(async () => []) },
    work = vi.fn(async (fn: () => Promise<unknown>) => {
      await fn();
    });
  const s = render(
    <ProjectImports
      data={{
        ...data,
        projectSync: { state: "pending", remaining: 1, error: "" },
      }}
      rpc={rpc}
      busy={false}
      act={work}
    />,
  );
  expect((s.getByLabelText("Import One") as HTMLInputElement).disabled).toBe(
    true,
  );
  expect((s.getByLabelText("Import Two") as HTMLInputElement).disabled).toBe(
    true,
  );
  fireEvent.click(s.getByRole("button", { name: "Imported", exact: true }));
  expect(s.queryByText("Two")).toBeNull();
  fireEvent.click(s.getByRole("button", { name: "Available", exact: true }));
  expect(s.queryByText("One")).toBeNull();
  fireEvent.click(s.getByRole("button", { name: "All", exact: true }));
  expect(s.getByText("One")).toBeTruthy();
  expect(s.getByRole("status").textContent).toContain(
    "1 selected imports remaining",
  );
  await act(async () => {});
});
it("retries unavailable models and keeps save disabled until the selected model is discovered", async () => {
  const rpc = {
      call: vi
        .fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValue([{ id: "m1", name: "Model" }]),
    },
    work = vi.fn(async (fn: () => Promise<unknown>) => {
      await fn();
    });
  const s = render(
    <ProjectImports data={data} rpc={rpc} busy={false} act={work} />,
  );
  fireEvent.click(s.getByText("Import defaults"));
  await s.findByRole("alert");
  fireEvent.click(s.getByRole("button", { name: "Retry models" }));
  await waitFor(() =>
    expect(
      (s.getByRole("button", { name: /Default model/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(s.getByRole("button", { name: /Default model/ }));
  fireEvent.click(s.getByRole("option", { name: "Model" }));
  fireEvent.click(s.getByLabelText(/Status only/));
  fireEvent.click(s.getByRole("switch"));
  fireEvent.click(s.getByRole("button", { name: "Save import defaults" }));
  await waitFor(() =>
    expect(rpc.call).toHaveBeenCalledWith(
      "configureProjectSync",
      expect.objectContaining({ summaries: false, allowSlackImport: false }),
    ),
  );
});
it("explains unavailable plugin services and lists builtin tools and shortcuts", () => {
  const s = render(
    <CapabilitySettings
      data={{
        extensible: false,
        plugins: [],
        builtins: [
          {
            name: "zana_import_project",
            title: "Import",
            description: "Choose one Project",
          },
        ],
        commands: [{ command: "/zana import", description: "Import one" }],
      }}
      busy={false}
      setEnabled={vi.fn()}
    />,
  );
  expect(s.getByText(/Update Zana/)).toBeTruthy();
  fireEvent.click(s.getByText(/Tools and channel shortcuts/));
  expect(s.getByText("zana_import_project")).toBeTruthy();
  expect(s.getByText("/zana import")).toBeTruthy();
});

it("searches and filters functionality switches, saves toggles and pauses individual plugin tools", () => {
  const setAccess = vi.fn(),
    setEnabled = vi.fn();
  const features = [
    {
      id: "launch",
      title: "Start new jobs",
      description: "Run work",
      tools: ["zana_launch_job"],
      enabled: true,
      available: true,
    },
    {
      id: "imports",
      title: "Import Projects",
      description: "Private channels",
      tools: ["zana_import_project"],
      enabled: false,
      available: false,
    },
    {
      id: "plugins",
      title: "Use plugin tools",
      description: "Opt in",
      tools: [],
      enabled: true,
      available: true,
    },
  ];
  const data = {
    features,
    builtins: [],
    commands: [],
    extensible: true,
    plugins: [
      {
        id: "demo.read",
        title: "Read demo",
        description: "Read data",
        pluginId: "demo",
        enabled: false,
      },
    ],
  };
  const props = { data, busy: false, setEnabled, setAccess };
  const s = render(<CapabilitySettings {...props} />);
  fireEvent.click(s.getByRole("switch", { name: "Allow Start new jobs" }));
  expect(setAccess).toHaveBeenCalledWith("launch", false);
  expect(
    (
      s.getByRole("switch", {
        name: "Allow Import Projects",
      }) as HTMLInputElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(s.getByRole("switch", { name: "Enable Read demo" }));
  expect(setEnabled).toHaveBeenCalledWith("demo.read", true);
  fireEvent.click(s.getByRole("button", { name: "Disabled" }));
  expect(s.queryByRole("switch", { name: "Allow Start new jobs" })).toBeNull();
  fireEvent.change(s.getByLabelText("Search Slack functionalities"), {
    target: { value: "zana_import" },
  });
  expect(s.getAllByRole("switch")).toHaveLength(1);
  fireEvent.change(s.getByLabelText("Search Slack functionalities"), {
    target: { value: "missing" },
  });
  expect(s.getByText("No matching functionalities.")).toBeTruthy();
  fireEvent.change(s.getByLabelText("Search Slack functionalities"), {
    target: { value: "" },
  });
  fireEvent.click(s.getByRole("button", { name: "Enabled" }));
  expect(s.getAllByRole("switch")).toHaveLength(2);
  fireEvent.click(s.getByRole("button", { name: "All" }));
  s.rerender(
    <CapabilitySettings
      {...props}
      data={{
        ...data,
        features: features.map((f) =>
          f.id === "plugins" ? { ...f, enabled: false } : f,
        ),
      }}
    />,
  );
  expect(
    (s.getByRole("switch", { name: "Enable Read demo" }) as HTMLInputElement)
      .disabled,
  ).toBe(true);
  expect(s.getByText(/Paused while plugin tools are off/)).toBeTruthy();
  s.rerender(<CapabilitySettings {...props} busy={true} />);
  expect(
    (
      s.getByRole("switch", {
        name: "Allow Start new jobs",
      }) as HTMLInputElement
    ).disabled,
  ).toBe(true);
});
