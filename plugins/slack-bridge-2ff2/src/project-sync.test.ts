import { expect, it } from "vitest";
import {
  managedChannelName,
  normalizeChannelPrefix,
  projectChannelNames,
} from "./project-sync.js";

it("uses a clean Project name first and a stable suffix only as fallback", () => {
  const [clean, collision] = projectChannelNames({
    id: "private/project/id",
    name: "My Café / Web App",
  });
  const [, sameCollision] = projectChannelNames({
    id: "private/project/id",
    name: "My Café / Web App",
  });
  const [, otherCollision] = projectChannelNames({
    id: "another",
    name: "My Café / Web App",
  });
  expect(clean).toBe("zana-my-cafe-web-app");
  expect(collision).toMatch(/^zana-my-cafe-web-app-[a-f0-9]{6}$/);
  expect(sameCollision).toBe(collision);
  expect(otherCollision).not.toBe(collision);
  expect(clean).not.toContain("private");
});

it("normalizes an optional prefix before zana and bounds long names", () => {
  expect(normalizeChannelPrefix("BT Internal ")).toBe("bt-internal");
  const [clean, collision] = projectChannelNames(
    { id: "p1", name: "A".repeat(200) },
    "Team One",
  );
  expect(clean).toMatch(/^team-one-zana-a+$/);
  expect(clean.length).toBeLessThanOrEqual(80);
  expect(collision.length).toBeLessThanOrEqual(80);
  expect(projectChannelNames({ id: "p2", name: "🔥 / !" })[0]).toBe(
    "zana-project",
  );
  expect(normalizeChannelPrefix("   ")).toBe("");
  expect(() => normalizeChannelPrefix("🔥")).toThrow("letter or number");
  expect(() => normalizeChannelPrefix("a".repeat(25))).toThrow("24");
});

it("accepts only bounded managed names containing the zana marker", () => {
  for (const name of [
    "zana-project",
    "zana-project-123456",
    "team-one-zana-project",
  ])
    expect(managedChannelName(name)).toBe(true);
  for (const name of [
    "general",
    "team-project",
    "zana-Upper",
    "-zana-two",
    "team--zana-project",
    "zana-a/../b",
    "zana-a ",
  ])
    expect(managedChannelName(name)).toBe(false);
});
