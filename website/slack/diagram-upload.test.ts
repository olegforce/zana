import { expect, it, vi } from "vitest";
import { diagramPng, uploadDiagram } from "./diagram-upload.mjs";
import { slackClient } from "./api.mjs";
const png = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex").toString("base64");
const ticket = { ok: true, upload_url: "https://files.slack.com/upload/v1/ticket", file_id: "F123456" };

it("uploads a bounded PNG without sharing a separate file message and returns only verified image metadata", async () => {
  const fetcher = vi.fn(async (url: string, args: any) => {
    if (url.includes("getUploadURL")) return Response.json(ticket);
    if (url.includes("/upload/v1/")) return new Response("OK");
    if (url.includes("completeUpload")) { expect(JSON.parse(args.body)).toEqual({ files: [{ id: ticket.file_id, title: "Diagram" }] }); return Response.json({ ok: true, files: [{ id: ticket.file_id }] }); }
    return Response.json({ ok: true, url: "https://test.slack.com/", user_id: "U999999" });
  });
  const value = await slackClient("secret", fetcher)("files.uploadDiagram", { png, channel_id: "ignored", path: "/private" });
  expect(value).toEqual({ ok: true, file_id: ticket.file_id, permalink: "https://test.slack.com/files/U999999/F123456/diagram.png" });
  const upload = fetcher.mock.calls.find(([url]) => url.includes("/upload/v1/"))!;
  expect(upload[1]).toMatchObject({ redirect: "error", headers: { "content-type": "image/png" } });
  expect(upload[1].headers.authorization).toBeUndefined();
  expect(fetcher.mock.calls).toHaveLength(4);
});
it.each([null, "", "bad", "a".repeat(220001), "AAAA====", Buffer.alloc(24).toString("base64"), Buffer.from("89504e470d0a1a0a0000000d494844520000000000000001", "hex").toString("base64"), Buffer.from("89504e470d0a1a0a0000000d494844520000064100000001", "hex").toString("base64")])("rejects invalid or oversized PNGs: %s", value => {
  expect(() => diagramPng(value)).toThrow("invalid_diagram");
});
it.each(["https://evil.example/upload/v1/a", "http://files.slack.com/upload/v1/a", "https://u:p@files.slack.com/upload/v1/a", "https://files.slack.com:8443/upload/v1/a", "https://files.slack.com/private"])("rejects unsafe upload tickets without transmitting image data", async url => {
  const call = vi.fn(async () => ({ ...ticket, upload_url: url })), fetcher = vi.fn();
  await expect(uploadDiagram(call, fetcher, { png })).rejects.toThrow("invalid_upload_ticket");
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(["ticket-rejected", "upload-rejected", "complete-rejected", "ambiguous", "ready", "bad-url", "info-lost", "info-rejected"])("handles %s without duplicate writes", async condition => {
  const call = vi.fn(async (method: string) => {
    if (method.includes("getUpload")) return condition === "ticket-rejected" ? { ok: false, error: "missing_scope" } : ticket;
    if (method.includes("completeUpload")) {
      if (condition === "ambiguous") throw new Error("lost");
      if (condition === "complete-rejected") return { ok: false, error: "invalid_file" };
      return { ok: true, files: condition === "ready" ? [{ id: ticket.file_id, permalink: "https://test.slack.com/files/U999999/F123456/diagram.png" }] : [] };
    }
    if (condition === "info-lost") throw new Error("read lost");
    return condition === "info-rejected" ? { ok: false } : { ok: true, file: { id: ticket.file_id, permalink: "https://evil.example/F123456" } };
  });
  const fetcher = vi.fn(async () => new Response("OK", { status: condition === "upload-rejected" ? 503 : 200 }));
  if (condition === "ambiguous") await expect(uploadDiagram(call, fetcher, { png })).rejects.toThrow("lost");
  else {
    const value = await uploadDiagram(call, fetcher, { png });
    expect(value.ok).toBe(!condition.endsWith("rejected") || condition === "info-rejected");
    if (["bad-url", "info-lost", "info-rejected"].includes(condition)) expect(value.permalink).toBeUndefined();
  }
  expect(call.mock.calls.filter(([m]) => m.includes("completeUpload")).length).toBeLessThanOrEqual(1);
});
