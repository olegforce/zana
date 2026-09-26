// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "../compat/testing-app";
import { makeTask } from "../test-fixtures.js";
import { TasksPanel } from "./panel.js";

const app = await loadPluginApp(() => import("../app"));
const registration = { ...app.navPanels[0]!, component: TasksPanel };
const project = { id: "01HZZZZZZZZZZZZZZZZZZZZZP1", name: "Mobile project", prefix: "TSK", nextTaskNumber: 3, color: "blue", folderId: null, linkedBbProjectId: null, createdAt: "2026-07-15T00:00:00.000Z" };
const otherProject = { ...project, id: "01HZZZZZZZZZZZZZZZZZZZZZP2", name: "Website", prefix: "WEB" };
const tasks = [makeTask({ title: "Make mobile comfortable" }), makeTask({ id: "T2", key: "TSK-2", title: "Check desktop", number: 2 })];
let compact = true;
const mediaListeners = new Set<() => void>();
function resize(isCompact: boolean) { act(() => { compact = isCompact; mediaListeners.forEach(fn => fn()); }); }
function renderTasks(subPath = "all", rpc = {}) {
  return renderSlot(registration, { subPath }, { rpc: {
    listProjects: () => ({ projects: [project, otherProject] }), listFolders: () => ({ folders: [] }),
    listPresets: () => ({ presets: [] }), sidebarSummary: () => ({ projects: [] }), listLabels: () => ({ labels: [] }),
    listTasks: () => ({ tasks }), getTaskByKey: ({ taskKey }: { taskKey: string }) => ({ task: tasks.find(t => t.key === taskKey) ?? null }),
    listTaskThreads: () => ({ taskThreads: [] }), listComments: () => ({ comments: [] }), listAttachments: () => ({ attachments: [] }),
    ...rpc,
  } });
}
beforeEach(() => {
  compact = true;
  vi.spyOn(window, "matchMedia").mockImplementation(query => ({
    get matches() { return query.includes("max-width") ? compact : false; }, media: query, onchange: null,
    addEventListener: (_: string, listener: () => void) => { mediaListeners.add(listener); },
    removeEventListener: (_: string, listener: () => void) => { mediaListeners.delete(listener); },
    addListener() {}, removeListener() {}, dispatchEvent: () => false,
  } as MediaQueryList));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); mediaListeners.clear(); });

describe("mobile Tasks navigation", () => {
  it("gives the list its own screen and closes project navigation after choosing the current route", async () => {
    const slot = renderTasks();
    await slot.findByRole("button", { name: "Open TSK-1: Make mobile comfortable" });
    expect(slot.container.querySelector(".tasks-desktop-navigation")).toBeNull();
    const trigger = slot.getByRole("button", { name: "Choose task project" });
    trigger.focus(); fireEvent.click(trigger);
    const sheet = await slot.findByRole("dialog", { name: "Projects" });
    const search = await within(sheet).findByRole("searchbox", { name: "Search task projects" });
    fireEvent.change(search, { target: { value: "unmatched" } });
    await within(sheet).findByText("No projects match your search.");
    fireEvent.change(search, { target: { value: "mobile" } });
    await within(sheet).findByText(project.name);
    expect(within(sheet).queryByText(otherProject.name)).toBeNull();
    fireEvent.click(within(sheet).getByRole("button", { name: /^All tasks/ }));
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    expect(slot.navigateCalls.at(-1)).toMatchObject({ options: { subPath: "all" } });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    fireEvent.click(trigger);
    const reopened = await slot.findByRole("dialog", { name: "Projects" });
    fireEvent.click(await within(reopened).findByRole("button", { name: "Close projects" }));
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
  });

  it("opens a searched project and closes the sheet on route changes or resize", async () => {
    const slot = renderTasks();
    fireEvent.click(await slot.findByRole("button", { name: "Choose task project" }));
    const sheet = await slot.findByRole("dialog", { name: "Projects" });
    fireEvent.change(await within(sheet).findByRole("searchbox"), { target: { value: "WEB" } });
    fireEvent.click(await within(sheet).findByText("Website"));
    expect(slot.navigateCalls.at(-1)).toMatchObject({ options: { subPath: otherProject.id } });
    slot.lifecycle.rerender(<TasksPanel subPath={otherProject.id} />);
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    expect(slot.queryByRole("button", { name: "Board", exact: true })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Choose task project" }));
    await slot.findByRole("dialog", { name: "Projects" });
    resize(false);
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    expect(slot.container.querySelector(".tasks-desktop-navigation")).not.toBeNull();
    expect(slot.getByRole("button", { name: "Board", exact: true })).toBeDefined();
    resize(true);
    expect(slot.queryByRole("dialog")).toBeNull();
  });

  it("finds projects inside collapsed folders without changing the folder preference", async () => {
    const folder = { id: "folder", name: "Archived", parentFolderId: null, createdAt: project.createdAt };
    const slot = renderTasks("all", { listFolders: () => ({ folders: [folder] }), listProjects: () => ({ projects: [{ ...project, folderId: folder.id }] }) });
    fireEvent.click(await slot.findByRole("button", { name: "Choose task project" }));
    const sheet = await slot.findByRole("dialog", { name: "Projects" });
    const folderButton = await within(sheet).findByRole("button", { name: "Archived" });
    fireEvent.click(folderButton);
    expect(within(sheet).queryByText(project.name)).toBeNull();
    fireEvent.change(within(sheet).getByRole("searchbox"), { target: { value: "mobile" } });
    await within(sheet).findByText(project.name);
    fireEvent.change(within(sheet).getByRole("searchbox"), { target: { value: "" } });
    expect(within(sheet).queryByText(project.name)).toBeNull();
  });

  it("keeps a search and its task button mounted through details, then restores focus on Back", async () => {
    const slot = renderTasks();
    const search = await slot.findByRole("searchbox", { name: "Search tasks" });
    fireEvent.change(search, { target: { value: "comfortable" } });
    const row = await slot.findByRole("button", { name: "Open TSK-1: Make mobile comfortable" });
    expect(slot.queryByRole("button", { name: /Open TSK-2/ })).toBeNull();
    row.focus(); fireEvent.click(row);
    expect(slot.navigateCalls.at(-1)).toMatchObject({ options: { subPath: "task/TSK-1" } });
    slot.lifecycle.rerender(<TasksPanel subPath="task/TSK-1" />);
    const back = await slot.findByRole("button", { name: "Back (Esc)" });
    expect(slot.queryByRole("searchbox", { name: "Search tasks" })).toBeNull();
    await slot.findByRole("textbox", { name: "Task title" });
    fireEvent.click(back);
    expect(slot.navigateCalls.at(-1)).toMatchObject({ options: { subPath: "all" } });
    slot.lifecycle.rerender(<TasksPanel subPath="all" />);
    expect(slot.getByRole("searchbox", { name: "Search tasks" })).toBe(search);
    expect((search as HTMLInputElement).value).toBe("comfortable");
    expect(slot.getByRole("button", { name: /Open TSK-1/ })).toBe(row);
    expect(document.activeElement).toBe(row);
  });

  it("clears an unmatched search and supports direct task links and a missing task", async () => {
    const slot = renderTasks();
    fireEvent.change(await slot.findByRole("searchbox", { name: "Search tasks" }), { target: { value: "missing" } });
    await slot.findByText("No tasks match these filters");
    fireEvent.click(slot.getByRole("button", { name: "Clear filters" }));
    await slot.findByRole("button", { name: /Open TSK-2/ });
    slot.lifecycle.unmount();
    const linked = renderTasks("task/TSK-999");
    await linked.findByText(/Task TSK-999 was not found/);
    fireEvent.click(linked.getByRole("button", { name: "Back (Esc)" }));
    expect(linked.navigateCalls.at(-1)).toMatchObject({ options: { subPath: "all" } });
  });

  it("leaves desktop rows unfiltered by a mobile search", async () => {
    const slot = renderTasks();
    fireEvent.change(await slot.findByRole("searchbox", { name: "Search tasks" }), { target: { value: "comfortable" } });
    await slot.findByText("1 task");
    resize(false);
    await slot.findByText("Check desktop");
    expect(slot.queryByRole("searchbox", { name: "Search tasks" })).toBeNull();
    resize(true);
    expect(slot.queryByRole("button", { name: /Open TSK-2/ })).toBeNull();
  });
});
