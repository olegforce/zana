import { expect, it, vi } from "vitest";
import { uploadDiagram } from "./diagram-upload.js";
const png = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001",
  "hex",
).toString("base64");
const ticket = {
  ok: true,
  upload_url: "https://files.slack.com/upload/v1/ticket",
  file_id: "F123456",
};
it.each([
  undefined,
  "bad",
  "a".repeat(220001),
  "AAAA====",
  Buffer.alloc(24).toString("base64"),
  Buffer.from(
    "89504e470d0a1a0a0000000d494844520000000000000001",
    "hex",
  ).toString("base64"),
  Buffer.from(
    "89504e470d0a1a0a0000000d494844520000064100000001",
    "hex",
  ).toString("base64"),
])("rejects invalid PNG input", async (value) => {
  await expect(uploadDiagram(vi.fn(), vi.fn(), value)).rejects.toThrow(
    "Invalid diagram",
  );
});
it.each([
  "http://files.slack.com/upload/v1/x",
  "https://files.slack.com:444/upload/v1/x",
  "https://u:p@files.slack.com/upload/v1/x",
  "https://elsewhere.example/upload/v1/x",
  "https://files.slack.com/private",
])("confines uploads to Slack's ticket endpoint", async (url) => {
  const fetcher = vi.fn();
  await expect(
    uploadDiagram(
      vi.fn(async () => ({ ...ticket, upload_url: url })),
      fetcher,
      png,
    ),
  ).rejects.toThrow("Invalid upload ticket");
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([
  "ready",
  "auth-ready",
  "ticket-rejected",
  "upload-rejected",
  "complete-rejected",
  "complete-lost",
  "info-lost",
  "info-rejected",
  "bad-permalink",
  "missing-permalink",
])(
  "handles %s with no upload notification or automatic write retry",
  async (condition) => {
    const call = vi.fn(async (method, args) => {
      if (method.includes("getUpload"))
        return condition === "ticket-rejected" ? { ok: false } : ticket;
      if (method.includes("completeUpload")) {
        expect(args).toEqual({
          files: [{ id: ticket.file_id, title: "Diagram" }],
        });
        if (condition === "complete-lost") throw new Error("lost");
        return condition === "complete-rejected"
          ? { ok: false }
          : {
              ok: true,
              files:
                condition === "ready"
                  ? [
                      {
                        id: ticket.file_id,
                        permalink:
                          "https://test.slack.com/files/U999999/F123456/diagram.png",
                      },
                    ]
                  : [],
            };
      }
      expect(method).toBe("auth.test");
      if (condition === "auth-ready")
        return { ok: true, url: "https://test.slack.com/", user_id: "U999999" };
      if (condition === "info-lost") throw new Error("lost read");
      return condition === "info-rejected"
        ? { ok: false }
        : {
            ok: true,
            file: {
              id: ticket.file_id,
              permalink:
                condition === "bad-permalink"
                  ? "https://elsewhere.example/F123456"
                  : undefined,
            },
          };
    });
    const fetcher = vi.fn(
      async () =>
        new Response("OK", {
          status: condition === "upload-rejected" ? 503 : 200,
        }),
    );
    if (condition === "complete-lost")
      await expect(uploadDiagram(call, fetcher, png)).rejects.toThrow("lost");
    else {
      const result = await uploadDiagram(call, fetcher, png);
      expect(result.ok).toBe(
        !["ticket-rejected", "upload-rejected", "complete-rejected"].includes(
          condition,
        ),
      );
      if (condition === "ready" || condition === "auth-ready")
        expect(result.permalink).toContain("test.slack.com");
      else expect(result.permalink).toBeUndefined();
    }
    expect(
      call.mock.calls.filter(([method]) => method.includes("completeUpload"))
        .length,
    ).toBeLessThanOrEqual(1);
  },
);
