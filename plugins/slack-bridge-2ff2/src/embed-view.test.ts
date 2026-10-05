import { afterEach, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { renderTask, sampleTask } from "./embed-view.js";
afterEach(() => vi.useRealTimers());
it("updates with textContent, shows stale snapshots on network loss, clears revoked data, and releases timers", async () => {
  vi.useFakeTimers();
  const v = sampleTask();
  const dom = new JSDOM(
    renderTask(
      { ...v, conversation: "https://app.slack.com/client/T/C" },
      "nonce",
    ),
    {
      url: "https://tasks.example.com/view/example?key=test",
      runScripts: "outside-only",
    },
  );
  const win = dom.window;
  const read = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      ...v,
      title: "<img onerror=alert(1)>",
      answer: "New answer",
      attention: true,
    }),
  });
  win.fetch = read;
  win.eval(win.document.querySelector("script")!.textContent!);
  await vi.advanceTimersByTimeAsync(10000);
  expect(win.document.querySelector("h1")!.textContent).toBe(
    "<img onerror=alert(1)>",
  );
  expect(win.document.querySelector("h1 img")).toBeNull();
  expect(win.document.querySelector("#answer")!.textContent).toBe("New answer");
  expect(read.mock.calls[0][1]).toMatchObject({
    credentials: "omit",
    cache: "no-store",
    referrerPolicy: "no-referrer",
  });
  read.mockRejectedValueOnce(new Error("offline"));
  await vi.advanceTimersByTimeAsync(10000);
  expect(win.document.querySelector("#connection")!.textContent).toContain(
    "Connection lost",
  );
  expect(win.document.querySelector("#answer")!.textContent).toBe("New answer");
  read.mockResolvedValueOnce({ status: 403 });
  await vi.advanceTimersByTimeAsync(10000);
  expect(win.document.querySelector("#answer")!.textContent).not.toBe(
    "New answer",
  );
  expect(win.document.querySelector("h1")!.textContent).toBe(
    "Task view closed",
  );
  win.dispatchEvent(new win.Event("pagehide"));
  expect(vi.getTimerCount()).toBe(0);
  win.close();
});
it("expires the displayed content even while the endpoint is offline", async () => {
  vi.useFakeTimers();
  const v = {
    ...sampleTask(),
    answer: "Private answer",
    expires: Date.now() + 1000,
  };
  const dom = new JSDOM(renderTask(v, "nonce"), {
    url: "https://tasks.example.com/view/example?key=test",
    runScripts: "outside-only",
  });
  dom.window.eval(dom.window.document.querySelector("script")!.textContent!);
  await vi.advanceTimersByTimeAsync(1000);
  expect(
    dom.window.document.querySelector("#answer")!.textContent,
  ).not.toContain("Private answer");
  expect(
    dom.window.document.querySelector("#connection")!.textContent,
  ).toContain("Access expired");
  expect(
    dom.window.document
      .querySelector("#state")!
      .parentElement!.classList.contains("unavailable"),
  ).toBe(true);
  dom.window.close();
});
it("loads hosted data with a fragment bearer and renders code as inert text with its language label", async () => {
  vi.useFakeTimers();
  const v = sampleTask();
  const dom = new JSDOM(
    renderTask(
      { ...v, answer: "", title: "Opening task" },
      "nonce",
      false,
      true,
    ),
    {
      url: "https://example.com/api/slack/tasks/link/view/entity#key=private-grant",
      runScripts: "outside-only",
    },
  );
  const read = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      ...v,
      expires: Date.now() + 1000,
      conversation: "https://app.slack.com/client/T/C",
      answer:
        'Example:\n```typescript\nconst tag = "<img src=x onerror=alert(1)>";\n```\nDone.',
    }),
  });
  dom.window.fetch = read;
  dom.window.eval(dom.window.document.querySelector("script")!.textContent!);
  await vi.advanceTimersByTimeAsync(0);
  expect(read.mock.calls[0][0]).toBe(
    "https://example.com/api/slack/tasks/link/data/entity",
  );
  expect(read.mock.calls[0][1].headers).toEqual({
    Accept: "application/json",
    Authorization: "Bearer private-grant",
  });
  expect(dom.window.document.querySelector("code")?.textContent).toBe(
    'const tag = "<img src=x onerror=alert(1)>";',
  );
  expect(dom.window.document.querySelector(".code-language")?.textContent).toBe(
    "typescript",
  );
  expect(dom.window.document.querySelector("#answer img")).toBeNull();
  expect(
    dom.window.document.querySelector("#conversation")?.hasAttribute("hidden"),
  ).toBe(false);
  await vi.advanceTimersByTimeAsync(1001);
  expect(dom.window.document.querySelector("code")).toBeNull();
  dom.window.dispatchEvent(new dom.window.Event("pagehide"));
  dom.window.close();
});

it("recovers from a temporary outage without duplicating refreshes and preserves long code lines", async () => {
  vi.useFakeTimers();
  const code = '  const value = "' + "x".repeat(1800) + '";';
  const view = {
    ...sampleTask(),
    answer: "Example:\n```typescript\n" + code + "\n```",
  };
  const dom = new JSDOM(renderTask(view, "nonce", false, true), {
    url: "https://example.com/link/view/task#key=grant",
    runScripts: "outside-only",
  });
  const fetch = vi
    .fn()
    .mockResolvedValue({ ok: true, status: 200, json: async () => view });
  dom.window.fetch = fetch;
  dom.window.eval(dom.window.document.querySelector("script")!.textContent!);
  await vi.advanceTimersByTimeAsync(0);
  expect(dom.window.document.querySelector("code")?.textContent).toBe(code);
  expect(dom.window.document.querySelectorAll("pre")).toHaveLength(1);
  fetch.mockRejectedValueOnce(new Error("computer asleep"));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(
    dom.window.document.querySelector("#connection")?.textContent,
  ).toContain("Connection lost");
  expect(dom.window.document.querySelector("code")?.textContent).toBe(code);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(
    dom.window.document.querySelector("#connection")?.textContent,
  ).toContain("Updated");
  expect(fetch).toHaveBeenCalledTimes(3);
  dom.window.dispatchEvent(new dom.window.Event("pagehide"));
  expect(vi.getTimerCount()).toBe(0);
  dom.window.close();
});
it("clears expired content immediately when a suspended panel becomes visible again", async () => {
  vi.useFakeTimers();
  const view = { ...sampleTask(), answer: "Private snapshot" };
  const dom = new JSDOM(renderTask(view, "nonce"), {
    url: "https://example.com/view/task?key=grant",
    runScripts: "outside-only",
  });
  dom.window.Date.now = () => Date.now();
  const fetch = vi.fn();
  dom.window.fetch = fetch;
  dom.window.eval(dom.window.document.querySelector("script")!.textContent!);
  dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
  expect(dom.window.document.querySelector("#answer")?.textContent).toBe(
    "Private snapshot",
  );
  vi.setSystemTime(view.expires + 1);
  dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
  expect(
    dom.window.document.querySelector("#answer")?.textContent,
  ).not.toContain("Private snapshot");
  expect(
    dom.window.document.querySelector("#connection")?.textContent,
  ).toContain("Access expired");
  expect(fetch).not.toHaveBeenCalled();
  dom.window.dispatchEvent(new dom.window.Event("pagehide"));
  dom.window.close();
});

it("shows interactive reports, preserves them offline and removes every report node when access ends", async () => {
  vi.useFakeTimers();
  const { sampleResult } = await import("./embed-view.js");
  const report = sampleResult();
  report.title = "Private report </script><img src=x>";
  const v = { ...sampleTask(), result: report };
  const dom = new JSDOM(renderTask(v, "nonce"), {
    url: "https://example.com/view/task?key=grant",
    runScripts: "outside-only",
  });
  const win = dom.window;
  const read = vi.fn().mockRejectedValue(new Error("offline"));
  win.fetch = read;
  win.eval(win.document.querySelector("script")!.textContent!);
  expect(win.document.querySelector("#result-data")).toBeNull();
  const tab = win.document.querySelector("#report-tab") as HTMLButtonElement;
  tab.click();
  expect(win.document.querySelector("#result")!.hasAttribute("hidden")).toBe(
    false,
  );
  expect(win.document.querySelector("#result img")).toBeNull();
  expect(win.document.querySelectorAll(".result-lane")).toHaveLength(3);
  (
    win.document.querySelector(
      'button[aria-label="Sort by Duration (ms)"]',
    ) as HTMLButtonElement
  ).click();
  expect(win.document.querySelector("tbody tr")?.textContent).toContain(
    "Permissions80",
  );
  read.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => structuredClone(v),
  });
  await vi.advanceTimersByTimeAsync(10000);
  expect(win.document.querySelector("tbody tr")?.textContent).toContain(
    "Permissions80",
  );
  await vi.advanceTimersByTimeAsync(10000);
  expect(win.document.querySelector("#result")?.textContent).toContain(
    "Private report",
  );
  read.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ ...v, result: undefined }),
  });
  await vi.advanceTimersByTimeAsync(10000);
  expect(win.document.querySelector("#result")?.textContent).toBe("");
  expect(
    win.document.querySelector("#summary-panel")?.hasAttribute("hidden"),
  ).toBe(false);
  read.mockResolvedValueOnce({ ok: true, status: 200, json: async () => v });
  await vi.advanceTimersByTimeAsync(10000);
  tab.click();
  read.mockResolvedValueOnce({ status: 410 });
  await vi.advanceTimersByTimeAsync(10000);
  expect(win.document.querySelector("#result")?.textContent).toBe("");
  expect(
    win.document.querySelector("#result-nav")?.hasAttribute("hidden"),
  ).toBe(true);
  win.dispatchEvent(new win.Event("pagehide"));
  expect(vi.getTimerCount()).toBe(0);
  win.close();
});
it("provides the same report renderer in a standalone synthetic demo without fetching", () => {
  const { result } = {
    result: {
      title: "Synthetic",
      sections: [
        { type: "text" as const, title: "Note", text: "No task was launched" },
      ],
    },
  };
  const dom = new JSDOM(
    renderTask({ ...sampleTask(), result }, "nonce", true),
    { runScripts: "outside-only" },
  );
  const fetch = vi.fn();
  dom.window.fetch = fetch;
  dom.window.eval(dom.window.document.querySelector("script")!.textContent!);
  (
    dom.window.document.querySelector("#report-tab") as HTMLButtonElement
  ).click();
  expect(dom.window.document.querySelector("#result")?.textContent).toContain(
    "No task was launched",
  );
  expect(fetch).not.toHaveBeenCalled();
  dom.window.close();
});
