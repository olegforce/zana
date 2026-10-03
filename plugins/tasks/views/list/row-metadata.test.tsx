// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "../../compat/testing-app";
import type { Label, Task, TaskThread } from "../../shared/contract.js";
import { makeTask } from "../../test-fixtures.js";

window.matchMedia ??= (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
});
window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView ??= () => {};

const app = await loadPluginApp(() => import("../../app"));

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(cleanup);

const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";

const project = {
  id: PROJECT_ID,
  name: "Tasks Plugin",
  prefix: "TSK",
  nextTaskNumber: 9,
  color: "blue",
  folderId: null,
  linkedBbProjectId: null,
  createdAt: "2026-07-15T00:00:00.000Z",
};

function task(number: number, labelIds: string[] = []): Task {
  return makeTask({
    id: `01HZZZZZZZZZZZZZZZZZZZZZT${number}`,
    projectId: PROJECT_ID,
    number,
    key: `TSK-${number}`,
    title: `Task ${number}`,
    position: number,
    labelIds,
  });
}

function thread(
  taskId: string,
  liveStatus: TaskThread["liveStatus"],
  suffix: string,
): TaskThread {
  return {
    id: `01HZZZZZZZZZZZZZZZZZZZZZH${suffix}`,
    taskId,
    threadId: `thr_${suffix}`,
    presetName: "Sonnet · high",
    title: "Worker",
    liveStatus,
    attachedAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  };
}

function label(suffix: string, name: string): Label {
  return {
    id: `01HZZZZZZZZZZZZZZZZZZZZZL${suffix}`,
    projectId: PROJECT_ID,
    name,
    color: "#5e6ad2",
  };
}

interface ListFixture {
  tasks: Task[];
  labels?: Label[];
  threadsByTask?: Record<string, TaskThread[]>;
  pageSize?: number;
  failPage?: boolean;
  failSummaries?: boolean;
}

function renderList(fixture: ListFixture, view = "list") {
  const calls = { listComments: 0, listAttachments: 0, listTasks: [] as { cursor?: string; limit?: number; activeOnly?: boolean; parentTaskId?: string | null }[], summaries: [] as string[][], threads: 0 };
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: `${PROJECT_ID}?view=${view}` },
    {
      rpc: {
        listProjects: () => ({ projects: [project] }),
        listFolders: () => ({ folders: [] }),
        listPresets: () => ({ presets: [] }),
        sidebarSummary: () => ({ projects: [] }),
        listLabels: () => ({ labels: fixture.labels ?? [] }),
        listTasks: (input: { cursor?: string; limit?: number }) => {
          calls.listTasks.push(input);
          if (fixture.failPage && input.cursor) throw new Error('Page temporarily unavailable');
          if ('activeOnly' in input && input.activeOnly && !('parentTaskId' in input)) return { tasks: [], nextCursor: null };
          const start = Number(input.cursor ?? 0);
          const size = fixture.pageSize ?? fixture.tasks.length;
          return { tasks: fixture.tasks.slice(start, start + size), nextCursor: start + size < fixture.tasks.length ? String(start + size) : null };
        },
        listTaskSummaries: ({ taskIds }: { taskIds: string[] }) => {
          calls.summaries.push(taskIds);
          if (fixture.failSummaries) throw new Error('Summary temporarily unavailable');
          return { summaries: taskIds.map(taskId => {
            const activeThreads = (fixture.threadsByTask?.[taskId] ?? []).filter(thread => thread.liveStatus === 'starting' || thread.liveStatus === 'working');
            return { taskId, activeThreads, activeThreadCount: activeThreads.length, attachmentCount: 0, subDone: 0, subTotal: 0 };
          }) };
        },
        listTaskThreads: () => { calls.threads += 1; return { taskThreads: [] }; },
        listComments: () => {
          calls.listComments += 1;
          return { comments: [] };
        },
        listAttachments: () => {
          calls.listAttachments += 1;
          return { attachments: [] };
        },
      },
    },
  );
  return { slot, calls };
}

describe("list-row Active chip", () => {
  it("shows the chip only for actively starting/working agents", async () => {
    const working = task(1);
    const starting = task(2);
    const historical = task(3);
    const bare = task(4);
    const { slot } = renderList({
      tasks: [working, starting, historical, bare],
      threadsByTask: {
        [working.id]: [thread(working.id, "working", "W1")],
        [starting.id]: [thread(starting.id, "starting", "S1")],
        [historical.id]: [
          thread(historical.id, "idle", "I1"),
          thread(historical.id, "completed", "C1"),
          thread(historical.id, "failed", "F1"),
        ],
      },
    });
    await slot.findByText("TSK-1");
    await waitFor(() => {
      expect(slot.getByTitle("Agent working")).toBeTruthy();
    });
    expect(slot.getByTitle("Agent working").textContent).toBe("Active");
    expect(slot.getByTitle("Agent starting").textContent).toBe("Active");
    expect(
      slot.getAllByText("Active", { selector: "span[title]" }),
    ).toHaveLength(2);
    expect(slot.queryByText(/Attached/)).toBeNull();
  });

  it("aggregates multiple live agents into one constant-text chip", async () => {
    const busy = task(1);
    const { slot } = renderList({
      tasks: [busy],
      threadsByTask: {
        [busy.id]: [
          thread(busy.id, "working", "W1"),
          thread(busy.id, "working", "W2"),
          thread(busy.id, "idle", "I1"),
        ],
      },
    });
    await slot.findByText("TSK-1");
    await waitFor(() => {
      expect(slot.getByTitle("2 agents working")).toBeTruthy();
    });
    expect(slot.getByTitle("2 agents working").textContent).toBe("Active");
  });
});

describe("list-row metadata rail", () => {
  it("fetches no comment/attachment data and renders no counts", async () => {
    const { slot, calls } = renderList({ tasks: [task(1), task(2)] });
    await slot.findByText("TSK-1");
    await waitFor(() =>
      expect(slot.getAllByRole("button").length > 0).toBe(true),
    );
    expect(calls.listComments).toBe(0);
    expect(calls.listAttachments).toBe(0);
    expect(slot.queryByTitle("Comments")).toBeNull();
    expect(slot.queryByTitle("Attachments")).toBeNull();
  });

  it("renders zero, one, and many labels with a bounded chip count", async () => {
    const labels = [
      label("A", "bug"),
      label("B", "frontend"),
      label("C", "needs-design"),
      label("D", "very-long-label-name-that-truncates"),
    ];
    const { slot } = renderList({
      tasks: [
        task(1),
        task(2, [labels[0]!.id]),
        task(
          3,
          labels.map((entry) => entry.id),
        ),
      ],
      labels,
    });
    await slot.findByText("TSK-1");

    expect(slot.getAllByText("bug").length).toBeGreaterThan(0);

    await waitFor(() => expect(slot.getByText("+2")).toBeTruthy());
    expect(slot.getByText("+3")).toBeTruthy();
    expect(slot.getByText("+2").getAttribute("title")).toBe(
      "needs-design, very-long-label-name-that-truncates",
    );
    expect(slot.getByText("+3").getAttribute("title")).toBe(
      "frontend, needs-design, very-long-label-name-that-truncates",
    );
    expect(slot.queryByText("needs-design")).toBeNull();
  });
});


describe('bounded task pages and summary invalidation', () => {
  it('loads only visible pages and refreshes one affected summary', async () => {
    const fixture: ListFixture = { tasks: Array.from({ length: 1000 }, (_, i) => task(i + 1)), pageSize: 100, threadsByTask: {} };
    const { slot, calls } = renderList(fixture);
    await slot.findByText('TSK-1');
    await waitFor(() => expect(calls.summaries).toHaveLength(1));
    expect(calls.listTasks.filter(input => 'parentTaskId' in input)).toHaveLength(1);
    expect(calls.listTasks.find(input => 'parentTaskId' in input)).toMatchObject({ limit: 100, parentTaskId: null, sort: 'manual' });
    expect(calls.summaries[0]).toHaveLength(100);
    expect(slot.queryByText('TSK-101')).toBeNull();
    fireEvent.click(slot.getByRole('button', { name: 'Load more tasks' }));
    await slot.findByText('TSK-101');
    await waitFor(() => expect(calls.summaries).toHaveLength(2));
    expect(calls.summaries[1]).toHaveLength(100);
    expect(calls.listTasks.filter(input => 'parentTaskId' in input)).toHaveLength(2);
    const changed = fixture.tasks[100]!;
    fixture.threadsByTask![changed.id] = [thread(changed.id, 'working', 'changed')];
    await slot.emitRealtime('threads:changed', { taskId: changed.id });
    await slot.findByTitle('Agent working');
    expect(calls.summaries.at(-1)).toEqual([changed.id]);
    expect(calls.listTasks.filter(input => 'parentTaskId' in input)).toHaveLength(2);
    expect(calls.threads).toBe(0);
    await slot.emitRealtime('threads:changed', { taskId: fixture.tasks[999]!.id });
    expect(calls.summaries).toHaveLength(3);
    await slot.emitRealtime('tasks:changed', { taskId: changed.id });
    await waitFor(() => expect(calls.listTasks.filter(input => 'parentTaskId' in input)).toHaveLength(3));
  });

  it('retries a failed next page without losing the first page', async () => {
    const fixture: ListFixture = { tasks: Array.from({ length: 110 }, (_, i) => task(i + 1)), pageSize: 100, failPage: true };
    const { slot, calls } = renderList(fixture);
    await slot.findByText('TSK-1');
    fireEvent.click(slot.getByRole('button', { name: 'Load more tasks' }));
    await waitFor(() => expect(calls.listTasks.filter(input => 'parentTaskId' in input)).toHaveLength(2));
    await slot.findByRole('alert');
    expect(slot.getByText('TSK-1')).toBeTruthy();
    fixture.failPage = false;
    fireEvent.click(slot.getByRole('button', { name: 'Load more tasks' }));
    await slot.findByText('TSK-110');
    expect(slot.queryByRole('button', { name: 'Load more tasks' })).toBeNull();
  });

  it('recovers failed summary batches and handles unscoped invalidation', async () => {
    const item = task(1);
    const fixture: ListFixture = { tasks: [item], failSummaries: true, threadsByTask: { [item.id]: [thread(item.id, 'starting', 'retry')] } };
    const { slot, calls } = renderList(fixture);
    await slot.findByText('TSK-1');
    await waitFor(() => expect(calls.summaries).toHaveLength(1));
    fixture.failSummaries = false;
    await slot.emitRealtime('threads:changed');
    await slot.findByTitle('Agent starting');
    expect(calls.summaries.at(-1)).toEqual([item.id]);
  });
});


it('keeps board loading bounded and updates its summary without relisting', async () => {
  const first = task(1);
  const fixture: ListFixture = { tasks: Array.from({ length: 110 }, (_, i) => task(i + 1)), pageSize: 100, threadsByTask: { [first.id]: [thread(first.id, 'working', 'board')] } };
  const { slot, calls } = renderList(fixture, 'board');
  await slot.findByText('Task 1');
  await slot.findByText('Sonnet · high');
  expect(calls.summaries).toHaveLength(1);
  expect(calls.listAttachments).toBe(0);
  expect(calls.threads).toBe(0);
  fireEvent.click(slot.getByRole('button', { name: 'Load more tasks' }));
  await slot.findByText('Task 110');
  await waitFor(() => expect(calls.summaries).toHaveLength(2));
  fixture.threadsByTask![first.id]!.push(thread(first.id, 'starting', 'board2'));
  await slot.emitRealtime('threads:changed', { taskId: first.id });
  await slot.findByText('2 agents');
  expect(calls.summaries.at(-1)).toEqual([first.id]);
  expect(calls.listTasks.filter(input => 'parentTaskId' in input)).toHaveLength(2);
});


it('keeps board cards usable when summary loading fails and recovers on invalidation', async () => {
  const item = task(1);
  const fixture: ListFixture = { tasks: [item], failSummaries: true, threadsByTask: { [item.id]: [thread(item.id, 'working', 'summary-retry')] } };
  const { slot, calls } = renderList(fixture, 'board');
  await slot.findByText('Task 1');
  await waitFor(() => expect(calls.summaries).toHaveLength(1));
  expect(slot.queryByText('Sonnet · high')).toBeNull();
  expect(slot.queryByLabelText(/attachments/)).toBeNull();
  fixture.failSummaries = false;
  await slot.emitRealtime('threads:changed', { taskId: item.id });
  await slot.findByText('Sonnet · high');
  expect(calls.summaries.at(-1)).toEqual([item.id]);
});

it('shows a next-page failure on the board and retries without removing its loaded cards', async () => {
  const fixture: ListFixture = { tasks: Array.from({ length: 110 }, (_, i) => task(i + 1)), pageSize: 100, failPage: true };
  const { slot } = renderList(fixture, 'board');
  await slot.findByText('Task 1');
  fireEvent.click(slot.getByRole('button', { name: 'Load more tasks' }));
  expect((await slot.findByRole('alert')).textContent).toContain('Page temporarily unavailable');
  expect(slot.getByText('Task 1')).toBeTruthy();
  expect(slot.queryByText('Task 110')).toBeNull();
  fixture.failPage = false;
  fireEvent.click(slot.getByRole('button', { name: 'Load more tasks' }));
  await slot.findByText('Task 110');
  expect(slot.queryByRole('alert')).toBeNull();
});
