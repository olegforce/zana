import {
  CHANNEL,
  MEMBER,
  TIMESTAMP,
  conversationKey,
  decodeSlack,
  object,
  type Binding,
  type Config,
  type Mention,
} from "./model.js";
import { ownsBinding } from "./home-view.js";

/** Ordinary messages can continue a live, owned binding, never create one. */
export function parseThreadReply(
  body: unknown,
  config: Config,
  lookup: (key: string) => Binding | undefined,
): Mention | null {
  const b = object(body),
    e = object(b.event),
    identity = config.identity;
  if (
    !config.enabled ||
    !identity ||
    !config.owner ||
    b.type !== "event_callback" ||
    e.type !== "message" ||
    b.team_id !== identity.team ||
    b.api_app_id !== identity.app ||
    typeof b.event_id !== "string" ||
    !b.event_id ||
    b.event_id.length > 100 ||
    e.bot_id ||
    e.subtype ||
    e.hidden ||
    !MEMBER.test(e.user) ||
    e.user !== config.owner ||
    !CHANNEL.test(e.channel) ||
    !TIMESTAMP.test(e.ts) ||
    !TIMESTAMP.test(e.thread_ts) ||
    e.thread_ts === e.ts ||
    Math.abs(Date.now() - Number(e.ts) * 1000) > 300_000 ||
    typeof e.text !== "string" ||
    !e.text.trim() ||
    e.text.length > 12000 ||
    // Slack also emits app_mention for these. That event owns the request.
    e.text.includes(`<@${identity.bot}>`)
  )
    return null;
  const m: Mention = {
    id: b.event_id,
    team: b.team_id,
    app: b.api_app_id,
    channel: e.channel,
    user: e.user,
    ts: e.ts,
    root: e.thread_ts,
    text: decodeSlack(e.text).trim(),
  };
  const binding = lookup(conversationKey(m));
  return binding &&
    ownsBinding(config, binding) &&
    (binding.user || binding.launch?.user || config.owner) === m.user &&
    !["archived", "deleted"].includes(binding.state)
    ? m
    : null;
}
