// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { restoreSetupRoute, settingsPath } from "./setup-navigation.js";

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

it("restores only the explicit setup deep link after the host's startup redirect", () => {
  const origin = window.location.origin;
  Object.defineProperty(window.performance, "getEntriesByType", {
    configurable: true,
    value: vi.fn(() => [
      { name: `${origin}/plugins/slack-bridge-2ff2/main/connect` },
    ]),
  });
  window.history.replaceState({ idx: 4 }, "", "/");
  const listener = vi.fn();
  window.addEventListener("popstate", listener);
  restoreSetupRoute("slack-bridge-2ff2");
  expect(window.location.pathname).toBe(
    "/extensions/plugins/slack-bridge-2ff2",
  );
  expect(window.location.search).toBe("?view=installed&setup=connect");
  expect(window.location.hash).toBe("#plugin-configure");
  expect(window.history.state).toEqual({ idx: 4 });
  expect(listener).toHaveBeenCalledTimes(1);
  restoreSetupRoute("slack-bridge-2ff2");
  expect(listener).toHaveBeenCalledTimes(1);
  window.removeEventListener("popstate", listener);
});

it.each([
  "https://outside.example/plugins/slack-bridge-2ff2/main/connect",
  "/plugins/other/main/connect",
  "/plugins/slack-bridge-2ff2/main/connect?secret=1",
  "/plugins/slack-bridge-2ff2/main/connect#other",
  "broken",
])("ignores a different or malformed initial URL: %s", (value) => {
  Object.defineProperty(window.performance, "getEntriesByType", {
    configurable: true,
    value: vi.fn(() => [
      { name: value.startsWith("/") ? window.location.origin + value : value },
    ]),
  });
  restoreSetupRoute("slack-bridge-2ff2");
  expect(window.location.pathname).toBe("/");
});

it("does not take over an existing navigation or an ordinary app launch", () => {
  Object.defineProperty(window.performance, "getEntriesByType", {
    configurable: true,
    value: vi.fn(() => []),
  });
  restoreSetupRoute("slack-bridge-2ff2");
  expect(window.location.pathname).toBe("/");
  for (const path of ["/threads/t1", "/?search=test", "/#elsewhere"]) {
    window.history.replaceState(null, "", path);
    restoreSetupRoute("slack-bridge-2ff2");
    expect(
      window.location.pathname + window.location.search + window.location.hash,
    ).toBe(path);
  }
});

it.each(["", "/connect"])(
  "moves a loaded legacy panel route to the plugin page: %s",
  (suffix) => {
    window.history.replaceState(
      null,
      "",
      `/plugins/slack-bridge-2ff2/main${suffix}`,
    );
    restoreSetupRoute("slack-bridge-2ff2");
    expect(
      window.location.pathname + window.location.search + window.location.hash,
    ).toBe(settingsPath("slack-bridge-2ff2", suffix === "/connect"));
  },
);

it("encodes the plugin id in settings links", () => {
  expect(settingsPath("a/b")).toBe(
    "/extensions/plugins/a%2Fb?view=installed#plugin-configure",
  );
});
