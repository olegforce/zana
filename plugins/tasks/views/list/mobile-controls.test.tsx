// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileTaskFilters } from "./mobile-filters.js";
import { MobileTaskRow } from "./mobile-row.js";
import { EMPTY_FILTERS, type ListFilterState } from "./filter-bar.js";
import type { TaskSort } from "../../shared/pagination.js";
import { makeTask } from "../../test-fixtures.js";
import type { TaskThread } from "../../shared/contract.js";

afterEach(cleanup);
function FiltersHarness({ count = 2, initial = EMPTY_FILTERS, labels = true }: { count?: number; initial?: ListFilterState; labels?: boolean }) {
  const [query, onQuery] = useState("");
  const [filters, onChange] = useState(initial);
  const [sort, onSortChange] = useState<TaskSort>("manual");
  return <MobileTaskFilters {...{ query, onQuery, filters, onChange, sort, onSortChange }} taskCount={count} labelOptions={labels ? [{ name: "Mobile", color: "blue" }] : []} />;
}

describe("mobile task filters", () => {
  it("searches and toggles status, priority and labels in a sheet, keeps selections, sorts and clears", async () => {
    const slot = render(<FiltersHarness />);
    const search = slot.getByRole("searchbox", { name: "Search tasks" });
    fireEvent.change(search, { target: { value: "iPhone" } });
    expect((search as HTMLInputElement).value).toBe("iPhone");
    const trigger = slot.getByRole("button", { name: "Filters" });
    trigger.focus(); fireEvent.click(trigger);
    const sheet = await slot.findByRole("dialog", { name: "Task filters" });
    await within(sheet).findByRole("button", { name: "Close task filters" });
    for (const name of ["In Progress", "High", "Mobile"]) {
      const checkbox = within(sheet).getByRole("checkbox", { name });
      fireEvent.click(checkbox);
      expect((checkbox as HTMLInputElement).checked).toBe(true);
      fireEvent.click(checkbox);
      expect((checkbox as HTMLInputElement).checked).toBe(false);
      fireEvent.click(checkbox);
    }
    fireEvent.change(within(sheet).getByLabelText("Sort tasks"), { target: { value: "priority" } });
    expect((within(sheet).getByLabelText("Sort tasks") as HTMLSelectElement).value).toBe("priority");
    fireEvent.click(within(sheet).getByRole("button", { name: "Show tasks" }));
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(slot.getByRole("button", { name: "Clear filters" })).toBeDefined();
    fireEvent.click(trigger);
    const reopened = await slot.findByRole("dialog");
    await within(reopened).findByRole("button", { name: "Close task filters" });
    expect((within(reopened).getByRole("checkbox", { name: "High" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(reopened).getByRole("button", { name: "Close task filters" }));
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    fireEvent.click(slot.getByRole("button", { name: "Clear filters" }));
    expect(slot.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });

  it("retains selected labels missing from the current catalogue and closes with Escape", async () => {
    const slot = render(<FiltersHarness count={1} labels={false} initial={{ ...EMPTY_FILTERS, labelNames: ["Archived label"] }} />);
    expect(slot.getByText("1 task")).toBeDefined();
    fireEvent.click(slot.getByRole("button", { name: "Filters" }));
    const sheet = await slot.findByRole("dialog");
    await within(sheet).findByRole("button", { name: "Close task filters" });
    expect((within(sheet).getByRole("checkbox", { name: "Archived label" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
  });

  it("shows loading before a count and omits an empty label section", async () => {
    const slot = render(<MobileTaskFilters query="" onQuery={() => {}} filters={EMPTY_FILTERS} onChange={() => {}} sort="manual" onSortChange={() => {}} labelOptions={[]} taskCount={undefined} />);
    expect(slot.getByText("Loading tasks…")).toBeDefined();
    fireEvent.click(slot.getByRole("button", { name: "Filters" }));
    const sheet = await slot.findByRole("dialog");
    await within(sheet).findByRole("button", { name: "Close task filters" });
    expect(within(sheet).queryByText("Labels")).toBeNull();
    fireEvent.click(within(sheet).getByRole("button", { name: "Close task filters" }));
  });
});

describe("mobile task row", () => {
  it("has one large target and readable project, status, priority, due date and working state", () => {
    const onOpen = vi.fn();
    const task = makeTask({ title: "Make mobile useful", status: "in_review", priority: "urgent", dueDate: "2026-09-27" });
    const thread: TaskThread = { id: "thread-link", taskId: task.id, threadId: "thread", presetName: "Worker", title: "Worker", liveStatus: "working", attachedAt: "2026-09-26", updatedAt: "2026-09-26" };
    const slot = render(<MobileTaskRow task={task} project={{ id: task.projectId, name: "Mobile", prefix: "TSK", color: "blue" }} showProject meta={{ activeThreads: [thread] }} onOpen={onOpen} pending />);
    const row = slot.getByRole("button", { name: "Open TSK-1: Make mobile useful" });
    expect(slot.getAllByRole("button")).toHaveLength(1);
    expect(row.getAttribute("aria-busy")).toBe("true");
    for (const name of ["Mobile", "TSK-1", "In Review", "Urgent", "Working"]) expect(slot.getByText(name)).toBeDefined();
    expect(row.querySelector(".tasks-working i")?.getAttribute("aria-hidden")).toBe("true");
    fireEvent.click(row); expect(onOpen).toHaveBeenCalledOnce();
  });

  it("omits absent metadata and repeated project names within a project", () => {
    const slot = render(<MobileTaskRow task={makeTask()} showProject={false} onOpen={() => {}} />);
    expect(slot.queryByText("Working")).toBeNull();
    expect(slot.queryByText("No priority")).toBeNull();
    expect(slot.getByRole("button").getAttribute("aria-busy")).toBeNull();
    slot.rerender(<MobileTaskRow task={makeTask()} showProject meta={{ activeThreads: [] }} onOpen={() => {}} />);
    expect(slot.getByText("TSK-1")).toBeDefined();
  });
});
