import { SocketModeClient, LogLevel } from "@slack/socket-mode";
import { WebClient, type WebClientOptions } from "@slack/web-api";
import type { SlackConnection, SlackResult } from "./model.js";
import { uploadDiagram } from "./diagram-upload.js";

// Never pass SDK diagnostics (which can include payloads/URLs) into product logs.
const quiet = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  setLevel() {},
  getLevel() {
    return LogLevel.ERROR;
  },
  setName() {},
};
export class BoundedSocket extends SocketModeClient {
  protected override async onWebSocketMessage(
    data: Parameters<SocketModeClient["onWebSocketMessage"]>[0],
    binary: boolean,
  ): Promise<void> {
    const bytes = Array.isArray(data)
      ? data.reduce((n, b) => n + b.byteLength, 0)
      : data.byteLength;
    if (bytes > 256 * 1024 || binary) return;
    await super.onWebSocketMessage(data, binary);
  }
}
export function createSlack(
  appToken: string,
  botToken: string,
): SlackConnection {
  const abort = new AbortController();
  const options: WebClientOptions = {
    logger: quiet,
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    timeout: 10000,
    maxRequestConcurrency: 2,
    requestInterceptor(config) {
      config.signal = abort.signal;
      config.maxContentLength = 256 * 1024;
      config.maxBodyLength = 256 * 1024;
      config.maxRedirects = 0;
      return config;
    },
  };
  const web = new WebClient(botToken, options);
  const socket = new BoundedSocket({
    appToken,
    logger: quiet,
    clientOptions: options,
    autoReconnectEnabled: false,
  });
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  return {
    async call(method, args = {}) {
      if (closed) throw new Error("Connection closed.");
      if (method === "files.uploadDiagram")
        return uploadDiagram(
          async (method, args) =>
            (await web.apiCall(method, args)) as SlackResult,
          (url, options) =>
            fetch(url, {
              ...options,
              signal: AbortSignal.any([abort.signal, options!.signal!]),
            }),
          args.png,
        );
      if (method === "chat.update" || method === "chat.postMessage") {
        const { conversation_ts, ...slackArgs } = args;
        args = slackArgs;
      }
      if (method === "canvases.create") {
        const { conversation_channel, conversation_ts, ...slackArgs } = args;
        args = slackArgs;
      }
      return (await web.apiCall(method, args)) as SlackResult;
    },
    async start(receive, state) {
      socket.on("slack_event", ({ body, ack }) => {
        if (!closed)
          void receive(body, ack).catch(() =>
            state("Could not save or acknowledge a Slack event."),
          );
      });
      let opening = false,
        established = false,
        retries = 0;
      const schedule = () => {
        if (closed || reconnectTimer) return;
        state("Reconnecting");
        reconnectTimer = setTimeout(
          () => {
            reconnectTimer = undefined;
            void open().catch(() => schedule());
          },
          Math.min(1000 * 2 ** Math.min(retries++, 5), 30000),
        );
        reconnectTimer.unref?.();
      };
      const open = async () => {
        if (closed) return;
        opening = true;
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            socket.start(),
            new Promise<never>((_, reject) => {
              deadline = setTimeout(
                () => reject(new Error("Slack handshake timed out.")),
                15000,
              );
              deadline.unref?.();
            }),
          ]);
          if (closed) await socket.disconnect();
        } catch (error) {
          const closing = socket.disconnect();
          socket.websocket?.disconnect();
          await closing;
          throw error;
        } finally {
          clearTimeout(deadline);
          opening = false;
        }
      };
      socket.on("connecting", () => state("Connecting"));
      socket.on("connected", () => {
        established = true;
        retries = 0;
        state("Connected");
      });
      socket.on("reconnecting", () => state("Reconnecting"));
      socket.on("disconnected", () => {
        state("Disconnected");
        if (established && !opening) schedule();
      });
      socket.on("error", () => state("Connection interrupted"));
      await open();
    },
    async close() {
      closed = true;
      clearTimeout(reconnectTimer);
      abort.abort();
      const closing = socket.disconnect();
      socket.websocket?.disconnect();
      await closing;
      socket.removeAllListeners();
    },
  };
}
