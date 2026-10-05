import type { RichResult } from "./rich-result.js";
export type Identity = { team: string; app: string; bot: string };
export type Route = {
  /** Conversation launches retain the configured channel as their authority. */
  sourceChannel?: string;
  channel: string;
  name: string;
  projectId: string;
  hostId: string;
  providerId: string;
  /** Optional only for persisted pre-model mappings; new launches require it. */
  model?: string;
  summaries: boolean;
};
export type Config = {
  /** Rotated on unlink/identity changes; missing only on pre-0.14.1 records. */
  ownerEpoch?: string;
  identity?: Identity;
  owner?: string;
  workspaceName?: string;
  ownerName?: string;
  routes: Route[];
  /** Explicit fallback for mentions in channels without a Project mapping. */
  mentionDefaultProjectId?: string;
  enabled: boolean;
  embed?: { origin: string; port: number; viaConnect?: boolean };
  /** Explicit opt-in for agent-composed reports, never arbitrary files/transcripts. */
  richResultsEnabled?: boolean;
  agentChatEnabled?: boolean;
  /** Owner's private DM may read reports across registered Projects. */
  inboxEnabled?: boolean;
  canvasEnabled?: boolean;
  questionsEnabled?: boolean;
  capabilityGrants?: Record<string, string>;
  slackAccess?: Partial<
    Record<
      "projects" | "launch" | "followups" | "status" | "answers" | "plugins",
      boolean
    >
  >;
  projectSync?: {
    /** Explicit imports only. Missing values migrate to existing managed routes. */
    projectIds?: string[];
    allowSlackImport?: boolean;
    enabled: boolean;
    /** Optional normalized label placed before the reserved zana marker. */
    channelPrefix?: string;
    hostId: string;
    providerId: string;
    model: string;
    summaries: boolean;
    pending?: {
      projectId: string;
      channel: string;
      name: string;
      prefix?: string;
      collision?: boolean;
    }[];
    channels?: {
      projectId: string;
      channel: string;
      name: string;
      prefix?: string;
      collision?: boolean;
    }[];
  };
};
export type Mention = {
  id: string;
  team: string;
  app: string;
  channel: string;
  user: string;
  root: string;
  ts: string;
  text: string;
};
export type Receipt = Mention & {
  state:
    | "received"
    | "queued"
    | "dispatching"
    | "running"
    | "settled"
    | "rejected"
    | "cancelled"
    | "needs-review";
  note: string;
  outcome?: "completed" | "failed" | "stopped";
  created: number;
  key: string;
  command?: string;
  requestedRoute?: Route;
  route?: Pick<Route, "projectId" | "hostId" | "providerId" | "model">;
};
export type LaunchConversation = {
  id: string;
  state: "ready";
  ownerEpoch?: string;
  team: string;
  app: string;
  user: string;
  source: Route;
  route: Route;
};
export type Binding = {
  /** Slack member who launched this conversation; legacy records use the linked owner. */
  user?: string;
  launch?: LaunchConversation;
  sourceChannel?: string;
  ownerEpoch?: string;
  key: string;
  channel: string;
  root: string;
  team: string;
  app: string;
  projectId: string;
  hostId: string;
  providerId: string;
  threadId: string;
  slackUrl?: string;
  /** Opaque, stable Work Object identifier; never a product thread credential. */
  entityId?: string;
  state: string;
  active?: string;
  lastRequest?: string;
  title?: string;
  needsAttention?: boolean;
  pendingInteractions?: string[];
  attentionCursor?: number;
  /** Coarse activity only; never store reasoning/tool content here. */
  activity?: "thinking" | "working";
  activityCursor?: number;
  activityItemId?: string;
  stopping?: boolean;
  paused?: boolean;
  updated: number;
};
export type Delivery = {
  /** Definitive image-block rejection can mean Slack is still processing a new upload. */
  imageRetries?: number;
  presentation?: "rich" | "compatible" | "text";
  diagrams?: import("./mermaid.js").Diagram[];
  /** Delete only this host-recorded status timestamp after a confirmed answer. */
  remove?: boolean;
  homeLaunchId?: string;
  questionId?: string;
  canvasId?: string;
  result?: RichResult;
  requestedRoute?: Route;
  origin?: "agent" | "operator" | "status";
  control?: boolean;
  id: string;
  key: string;
  channel: string;
  root: string;
  text: string;
  state:
    | "queued"
    | "sending"
    | "sent"
    | "removed"
    | "failed"
    | "uncertain"
    | "reviewed";
  created: number;
  next: number;
  attempts: number;
  note: string;
  ts?: string;
  /** One durable message per turn; revisions preserve updates during an HTTP call. */
  card?: boolean;
  requestId?: string;
  revision?: number;
  modified?: number;
};
export type HomeLaunch = {
  selection?: { project: string; provider: string; channel: string };
  ownerEpoch?: string;
  callerChannel?: string;
  replyRoot?: string;
  source?: Route;
  providers?: { id: string; name: string }[];
  catalog?: Record<string, { id: string; name: string }[]>;
  offer?: "queued" | "sending" | "sent" | "failed" | "uncertain";
  offerTs?: string;
  id: string;
  team: string;
  app: string;
  user: string;
  state: "draft" | "queued" | "settled" | "rejected" | "needs-review";
  created: number;
  expires: number;
  routes: Route[];
  route?: Route;
  viewId?: string;
  task: string;
  note: string;
};
export type SlackAck = (response?: Record<string, unknown>) => Promise<void>;
export type SlackResult = Record<string, any>;
/** SDK platform errors are definitive rejections; transport errors remain ambiguous. */
export async function slackCall(
  client: SlackConnection,
  method: string,
  args: Record<string, unknown>,
): Promise<SlackResult> {
  try {
    return await client.call(method, args);
  } catch (error) {
    const e = object(error);
    if (
      e.code === "slack_webapi_platform_error" &&
      typeof e.data?.error === "string"
    )
      return { ok: false, error: e.data.error };
    throw error;
  }
}
export interface SlackConnection {
  call(method: string, args?: Record<string, unknown>): Promise<SlackResult>;
  start(
    receive: (body: unknown, ack: SlackAck) => Promise<void>,
    state: (value: string) => void,
  ): Promise<void>;
  close(): Promise<void>;
}
export const CHANNEL = /^[CG][A-Z0-9]{5,30}$/;
export const DIRECT = /^D[A-Z0-9]{5,30}$/;
export function ownerDirect(
  value: unknown,
  owner: string | undefined,
): boolean {
  const c = object(value);
  return (
    !!owner &&
    DIRECT.test(c.id) &&
    c.user === owner &&
    c.is_im === true &&
    c.is_mpim !== true &&
    c.is_archived !== true
  );
}
export const MEMBER = /^[UW][A-Z0-9]{5,30}$/;
export const APP = /^A[A-Z0-9]{5,30}$/;
export const TIMESTAMP = /^\d{10,16}\.\d{6}$/;
export const slackLink = (
  team: string,
  channel: string,
  root?: string,
): string =>
  `https://app.slack.com/client/${encodeURIComponent(team)}/${encodeURIComponent(channel)}${root ? `?thread_ts=${encodeURIComponent(root)}&cid=${encodeURIComponent(channel)}` : ""}`;
export const object = (value: unknown): Record<string, any> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
export function string(value: unknown, max = 2000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error("Missing or invalid input.");
  return value.trim();
}
export function parseMention(
  body: unknown,
  identity: Identity,
): Mention | null {
  const b = object(body),
    e = object(b.event);
  if (
    JSON.stringify(b).length > 256 * 1024 ||
    b.type !== "event_callback" ||
    e.type !== "app_mention" ||
    e.bot_id ||
    e.subtype ||
    b.team_id !== identity.team ||
    b.api_app_id !== identity.app
  )
    return null;
  if (
    typeof b.event_id !== "string" ||
    b.event_id.length > 100 ||
    !MEMBER.test(e.user) ||
    !CHANNEL.test(e.channel) ||
    !TIMESTAMP.test(e.ts) ||
    (e.thread_ts && !TIMESTAMP.test(e.thread_ts)) ||
    typeof e.text !== "string" ||
    e.text.length > 12000
  )
    return null;
  const mention = `<@${identity.bot}>`;
  if (!e.text.includes(mention)) return null;
  return {
    id: b.event_id,
    team: b.team_id,
    app: b.api_app_id,
    channel: e.channel,
    user: e.user,
    ts: e.ts,
    root: e.thread_ts || e.ts,
    text: decodeSlack(e.text.split(mention).join("")).trim(),
  };
}
export const conversationKey = (
  m: Pick<Mention, "team" | "app" | "channel" | "root">,
): string => [m.team, m.app, m.channel, m.root].join(":");
export function internalChannel(value: unknown): boolean {
  const c = object(value);
  return (
    CHANNEL.test(c.id) &&
    c.is_member === true &&
    c.is_archived === false &&
    c.is_shared === false &&
    c.is_ext_shared === false &&
    c.is_org_shared === false &&
    c.is_im !== true &&
    c.is_mpim !== true
  );
}
// Slack markup must not turn a generated summary into a broadcast mention or link.
export const plainSlack = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
// Decode exactly one Slack transport layer, including literal '&amp;lt;' text.
export const decodeSlack = (text: string): string =>
  text.replace(
    /&(amp|lt|gt);/g,
    (_, entity: string) => ({ amp: "&", lt: "<", gt: ">" })[entity]!,
  );
