import { afterEach, describe, expect, it, vi } from "vitest";
import { WebClient } from "@slack/web-api";
import { SocketModeClient } from "@slack/socket-mode";
import { WebSocketServer } from "ws";
import { createSlack, BoundedSocket } from "./slack.js";
import { body } from "../test/helpers.js";
afterEach(() => vi.restoreAllMocks());
describe("Slack transport", () => {
  it("uploads a generated diagram privately and removes Connect-only conversation arguments", async () => {
    const api = vi.spyOn(WebClient.prototype, "apiCall").mockImplementation(async method => method === "files.getUploadURLExternal" ? { ok: true, upload_url: "https://files.slack.com/upload/v1/ticket", file_id: "F123456" } : { ok: true, files: [{ id: "F123456", permalink: "https://test.slack.com/files/U999999/F123456/diagram.png" }] });
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("OK"));
    const client = createSlack("xapp-test", "xoxb-test");
    try {
      expect(await client.call("files.uploadDiagram", { png: Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex").toString("base64") })).toHaveProperty("file_id", "F123456");
      expect(fetcher.mock.calls[0][1]).toHaveProperty("signal");
      await client.call("chat.postMessage", { text: "Diagram", conversation_ts: "1791050000.000001" });
      expect(api).toHaveBeenLastCalledWith("chat.postMessage", { text: "Diagram" });
    } finally { await client.close(); }
  });
  it("uses a real WebSocket handshake and ACK, reports reconnects, and closes cleanly", async () => {
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => server.on("listening", r));
    const port = (server.address() as any).port;
    const ack = new Promise<any>((resolve) =>
      server.on("connection", (ws) => {
        ws.send(JSON.stringify({ type: "hello" }));
        ws.on("message", (data) => resolve(JSON.parse(data.toString())));
        setImmediate(() =>
          ws.send(
            JSON.stringify({
              type: "events_api",
              envelope_id: "env-1",
              payload: body(),
            }),
          ),
        );
      }),
    );
    vi.spyOn(WebClient.prototype, "apiCall").mockImplementation(
      async (method, args) =>
        method === "apps.connections.open"
          ? { ok: true, url: `ws://127.0.0.1:${port}` }
          : { ok: true, channel: args?.channel, ts: "1234567890.000001" },
    );
    const bridge = createSlack("xapp-test", "xoxb-test"),
      receive = vi.fn(async (_body, reply) => {
        await reply();
      }),
      state = vi.fn();
    try {
      await bridge.start(receive, state);
      expect(await ack).toMatchObject({ envelope_id: "env-1" });
      expect(receive.mock.calls[0][0]).toMatchObject({ event_id: "Ev1" });
      expect(state).toHaveBeenCalledWith("Connected");
      expect(await bridge.call("auth.test")).toMatchObject({ ok: true });
      await bridge.call("canvases.create", {
        conversation_channel: "C123456",
        conversation_ts: "1234567890.000001",
        title: "Fixture",
        document_content: { type: "markdown", markdown: "Shared answer" },
      });
      expect(WebClient.prototype.apiCall).toHaveBeenLastCalledWith(
        "canvases.create",
        {
          title: "Fixture",
          document_content: { type: "markdown", markdown: "Shared answer" },
        },
      );
    } finally {
      await bridge.close();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((r) => server.close(() => r()));
    }
    await expect(bridge.call("auth.test")).rejects.toThrow("closed");
  });
  it("does not parse oversized/binary frames and catches receipt failures without logging payloads", async () => {
    const socket = new BoundedSocket({
      appToken: "xapp-test",
      logLevel: "error" as any,
    });
    const emit = vi.spyOn(socket, "emit");
    await (socket as any).onWebSocketMessage(
      Buffer.alloc(256 * 1024 + 1),
      false,
    );
    await (socket as any).onWebSocketMessage(
      [Buffer.alloc(256 * 1024), Buffer.alloc(1)],
      false,
    );
    await (socket as any).onWebSocketMessage(Buffer.from("{}"), true);
    expect(emit).not.toHaveBeenCalled();
    let current: SocketModeClient | undefined;
    vi.spyOn(SocketModeClient.prototype, "start").mockImplementation(
      async function (this: SocketModeClient) {
        current = this;
        return { ok: true };
      },
    );
    const connection = createSlack("xapp-test", "xoxb-test");
    const state = vi.fn();
    await connection.start(async () => {
      throw new Error("db full");
    }, state);
    current!.emit("slack_event", { body: {}, ack: async () => {} });
    current!.emit("reconnecting");
    current!.emit("error", new Error("secret payload"));
    await new Promise((r) => setImmediate(r));
    expect(state).toHaveBeenCalledWith(
      "Could not save or acknowledge a Slack event.",
    );
    expect(state).toHaveBeenCalledWith("Reconnecting");
    expect(state).toHaveBeenCalledWith("Connection interrupted");
    await connection.close();
  });
});

it("owns reconnect timers and cancels them on disposal", async () => {
  vi.useFakeTimers();
  let current: SocketModeClient | undefined;
  const start = vi
    .spyOn(SocketModeClient.prototype, "start")
    .mockImplementation(async function (this: SocketModeClient) {
      current = this;
      this.emit("connected");
      return { ok: true };
    });
  const connection = createSlack("xapp-test", "xoxb-test"),
    state = vi.fn();
  try {
    await connection.start(async () => {}, state);
    current!.emit("disconnected");
    expect(state).toHaveBeenCalledWith("Reconnecting");
    await vi.advanceTimersByTimeAsync(1000);
    expect(start).toHaveBeenCalledTimes(2);
    current!.emit("disconnected");
    await connection.close();
    await vi.advanceTimersByTimeAsync(60000);
    expect(start).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  {
    type: "interactive",
    payload: {
      type: "view_submission",
      view: { callback_id: "zana_launch_v1" },
    },
    reply: { response_action: "errors", errors: { task: "Enter a task." } },
  },
  {
    type: "slash_commands",
    payload: {
      command: "/zana",
      text: "projects",
      team_id: "T123456",
      user_id: "U123456",
      channel_id: "C123456",
      trigger_id: "trigger",
    },
    reply: {
      response_type: "ephemeral",
      text: "Connected Projects",
      blocks: [
        { type: "section", text: { type: "plain_text", text: "Project" } },
      ],
    },
  },
])(
  "carries $type responses over the actual Socket Mode ACK envelope",
  async ({ type, payload, reply }) => {
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.on("listening", resolve));
    const port = (server.address() as any).port;
    const response = new Promise<any>((resolve) =>
      server.on("connection", (ws) => {
        ws.send(JSON.stringify({ type: "hello" }));
        ws.on("message", (data) => resolve(JSON.parse(data.toString())));
        setImmediate(() =>
          ws.send(
            JSON.stringify({
              type,
              envelope_id: "modal-1",
              accepts_response_payload: true,
              payload,
            }),
          ),
        );
      }),
    );
    vi.spyOn(WebClient.prototype, "apiCall").mockResolvedValue({
      ok: true,
      url: `ws://127.0.0.1:${port}`,
    } as any);
    const client = createSlack("xapp-test", "xoxb-test");
    try {
      await client.start(
        async (received: any, ack) => {
          expect(received).toEqual(payload);
          await ack(reply);
        },
        () => {},
      );
      expect(await response).toEqual({
        envelope_id: "modal-1",
        payload: reply,
      });
    } finally {
      await client.close();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
