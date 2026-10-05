# Reply without repeating @Zana

Start work with `@Zana <task>`. Once that request has created a Zana conversation, its launcher can send ordinary replies in the same Slack thread. The same agent and saved execution profile continue; the message cannot create a new conversation or switch Projects. Plain `stop`, `mute`, `unmute` and `status` use the existing controls.

Other members, bot messages, edits, broadcasts, top-level channel messages and unrelated threads are ignored. Revoked, archived or deleted conversations cannot resume. Both the gateway and plugin check the original owner; new bindings store the launching Slack member. Legacy bindings remain restricted to their linked owner and owner epoch.

Slack must deliver these messages before this can work. Enable bot events `message.channels` and `message.groups` with bot scopes `channels:history` and `groups:history`, then reinstall the app in the workspace. These scopes cover message access in channels the bot has joined; Slack has no subscription limited to Zana task threads. The gateway drops unrelated messages without persisting their content. No channel-history retrieval method is exposed by this change.

The hosted gateway and receiver both need the thread-reply update. Socket Mode installations need the same event subscriptions. Mentions remain compatible: a message containing the bot mention is handled solely by `app_mention`, preventing two agent turns when Slack delivers both event types.

Changing subscriptions does not recover an earlier reply that Slack never sent. After activation, resend the missed reply once in its original thread if its agent is still available. If the agent was deleted or archived, launch again with `@Zana` first.

The minimal hosted manifest is in the main repository at `docs/slack-configuration/app-manifest-thread-replies.json`. It preserves the recorded existing app and adds only the two channel events and two history scopes. These were approved, installed and verified with real mention-free replies in public and private Internal-Sandbox channels on 3 October 2026. Both replies continued the same bound agent and produced one confirmed answer with temporary status cleanup. DM, native agent view and Canvas permissions are separate.
