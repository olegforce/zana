# Reproduce the Zana Slack configuration

This directory records the working Zana Slack settings exported on **1 October 2026**, including the Zana fairy avatar, with channel-thread replies activated on **3 October 2026** and native private agent chat activated on **4 October 2026**. It contains a reproducible app manifest and a portable installation template; the plugin's sample manifest has different defaults. Exact user, computer, Project, and channel identifiers are retained in the original operator's local project Library and are excluded from these public files.

## Saved configuration

| File | Purpose |
| --- | --- |
| [app-manifest.json](app-manifest.json) | Downloaded live export after native agent chat activation on 4 October. Includes Home, bot presence, `/zana`, scopes, signed HTTP events, interactivity, task previews, and the custom MCP server. |
| [app-manifest-2026-10-03.json](app-manifest-2026-10-03.json) | Preserved channel-thread reply record before native agent activation. |
| [app-manifest-2026-10-01.json](app-manifest-2026-10-01.json) | Preserved exact original export before channel-thread replies were enabled. |
| [installation-template.json](installation-template.json) | Placeholders for installation IDs, separately configured display/iframe settings, logo checksum, plugin version, and an example Project/channel route. |
| [zana-icon-512.png](../../website/public/zana-icon-512.png) | The actual uploaded 512 × 512 Zana fairy artwork, already stored in this repository. |

Fill the template's `<...>` placeholders with your app, workspace, linked owner, execution host, Project, and channel IDs. These identifiers are installation-specific; the template is a setup reference, not an automatically imported settings file.

## 1. Create or restore the Slack app

Open [Your Apps](https://api.slack.com/apps), select the app, and open **App Manifest**. For a new installation, use **Create New App → From a manifest**, choose its workspace, and supply `app-manifest.json`. Use Slack's preview/validation before saving.

The recorded endpoints use `https://zana-ide.com`. For a different hosted installation, replace that origin in the event/interactivity/slash-command URLs, MCP URL, and preview domain allowlist. A new installation generates its own app, user, and channel IDs; use those in the hosted and local setup.

Confirm these settings after applying the manifest:

| Setting | Recorded value |
| --- | --- |
| App / bot name | `Zana` |
| Home tab | Enabled |
| Messages tab | Enabled and editable |
| Native agent view | Enabled; agent task history enabled |
| Bot always online | Enabled |
| Socket Mode | Disabled — this installation uses hosted HTTP delivery |
| Events, interactivity, `/zana` Request URL | `https://zana-ide.com/api/slack/events/` |
| Bot events | `app_home_opened`, `app_mention`, `entity_details_requested`, `message.channels`, `message.groups`, `message.im`, `app_context_changed`, `agent_session_stopped`, `agent_session_title_changed` |
| Bot scopes | `groups:write`, `app_mentions:read`, `channels:read`, `chat:write`, `commands`, `groups:read`, `mcp:connect`, `users:read`, `channels:history`, `groups:history`, `files:write`, `im:read`, `im:history`, `assistant:write` |
| Work Object Previews | Enabled; entity type `slack#/entities/file` |
| Preview domain allowlist | Exactly `zana-ide.com` |
| MCP server | `Zana jobs` → `https://zana-ide.com/api/slack/mcp/`, auth `slack_identity_auth` |

The live export includes `settings.is_mcp_enabled: false` alongside the working custom `mcp_servers` entry. Preserve the exported configuration rather than interpreting that flag as a reason to toggle another feature. Fetch the custom server's tools in Slack and connect Zana under **Slackbot → Apps**. Workspace installation and scope approval are separate from manifest application.

## 2. Apply settings outside the manifest

In your Slack app settings, open **Basic Information → Display Information → App icon & Preview**. Upload `website/public/zana-icon-512.png`. The saved app name is `Zana`, the background color is `#2C2D30`, and the short/long descriptions were empty when recorded.

Verify the asset from the repository root:

```sh
shasum -a 256 website/public/zana-icon-512.png
```

Expected SHA-256:

```text
6f403b768f5c246e5241fa154b97338a7e5a1353fdfab1059e87ea7aaa6149cc
```

Slack confirmed **Success!** immediately after upload and displayed the fairy in the app preview. Refresh the Slack client if its existing message avatars are cached; on macOS, **⌘R** refreshed them. Confirm the fairy appears beside Zana's messages, in the app header, and on task attachments.

In your Slack app settings, open **Work Object Previews** and leave **allow-same-origin off**. This switch was checked directly in the live UI and is not included in the downloaded manifest. See [Slack's manifest schema](https://docs.slack.dev/reference/app-manifest/) and [embedded previews](https://docs.slack.dev/messaging/work-objects-embeds/) for the supported settings.

## 3. Reconnect the hosted service and desktop plugin

Follow [Slack through Zana Connect](../slack-connect.md) for the hosted service deployment. Configure `SLACK_APP_ID`, `SLACK_TEAM_ID`, `SLACK_BOT_TOKEN`, and `SLACK_SIGNING_SECRET` through its secret store, alongside the existing Connect account/database configuration. This record stores variable names and placeholders; credentials stay in the secret store and must be obtained through the normal installation flow.

Install **Zana for Slack** (`slack-bridge-2ff2`; recorded version `0.14.4`). Connect the selected computer through **Settings → Remote access**, then open **Zana → Home** in Slack. Use the account linking flow and approve the one-time activation code in **Plugins → Zana for Slack → Configuration** on that computer.

Under **Custom task panel in Slack**, choose **Enable custom web panels**. The recorded panel uses the existing Connect transport, public origin `https://zana-ide.com`, and local listener port `8792`. Connect users do not configure a separate public tunnel or hostname for this panel.

Restore the Project/channel connections in **Manage connected channels**, selecting the registered execution host, local Project, and Slack channel for each route. The recorded routes used provider `codex`, model `gpt-6-astra`, and `summaries: true`; choose a model available to your installation. `installation-template.json` shows the route shape with placeholder IDs. Add one entry per desired channel; more than one channel can map to the same Project.

The exact five-route snapshot and original guide are preserved locally in **Project Library → Private Zana Slack installation backup — 1 October 2026** (`integrations/slack-installation-private-2026-10-01.md`). That local backup lives under Git-ignored `.zcc/` and is not included in the public repository. On a different computer, select its registered execution host and local Projects and use the new channel IDs. Import only explicitly selected Projects. Public CLI status does not expose every import default or optional plugin-tool toggle; configure those choices deliberately using the [user guide](../slack-user-guide.md).

## 4. Verify the restored setup

Run the read-only status command:

```sh
zcc slack-bridge-2ff2 status
```

Expect `connection: "Connected"`, the intended channel routes, and `embed.listening: true` / `embed.viaConnect: true`. In Slack, verify Home loads, `/zana` opens its picker, and an owner-authored `@Zana` task starts in a connected channel. Confirm an answer has a **sent** delivery record, a mention follow-up stays in the same thread, and the **Agent task** attachment opens the custom panel. Verify the logo on real bot messages after refreshing.

Recorded verification: the exported manifest and iframe switch were read directly from the live app; the plugin status reported Connected and the five routes retained in the local backup; the logo appeared on existing bot messages after a Slack refresh. Saving this record did not launch a new task or repeat the earlier job/command acceptance tests. Their procedures and prior results are in [Slackbot setup](../slackbot-app.md) and the user guide.

## Keep the record current

### Native Slack agent chat

[`app-manifest-agent-chat.json`](app-manifest-agent-chat.json) is the **agent-only** activation template, applied on 4 October 2026. It enables the editable Messages tab and `features.agent_view`, with `message.im`, `app_context_changed`, `agent_session_stopped`, and `agent_session_title_changed`. The new bot scopes are `im:read`, `im:history`, and `assistant:write`. Canvas permissions are not included. It preserves the existing channel events, MCP server, preview configuration and model callback, including the `files:write` scope already activated for diagrams on 3 October.

Before saving, compare it with a fresh export from the actual Slack app and preserve any installation-specific settings. Apply it in **App Manifest**, complete the workspace scope approval and reinstall, then enable **Private agent chat** in **Plugins → Zana for Slack → Configuration**. Existing account linking and Project connections supply the owner, execution computer and sharing policy. The user approved this expansion, Zana was reinstalled in Internal-Sandbox, and **Private agent chat** was enabled on 4 October 2026. A live owner DM launched an agent after Project selection and delivered an answer; a plain threaded follow-up continued the same Zana conversation. The native Stop control is still under verification.

Open Zana's Messages tab, send a synthetic task and choose a connected Project. Verify one answer, native progress/stop, and a plain reply in the same task thread. `@Zana` is optional in DMs; a bare mention in an existing task shows status. Stop and follow-ups retain the chosen Project. The connected computer must remain online. Native controls use the current Messages-based Slack agent view; new apps do not use the older Chat/History assistant view. See [Slack's agent guide](https://docs.slack.dev/ai/developing-agents/).

`app-manifest-full-ui.json` is the prepared expansion for private agent chat and Canvas. It preserves the recorded app name, bot presence, `Zana jobs` MCP server, and preview domain settings while adding DM events, agent view, and `im:read`, `im:history`, `assistant:write`, and `canvases:write`. It has not been applied to the live app. Review those access changes and reinstall after scope approval; deploy the updated hosted gateway before enabling these surfaces.

After changing the Slack app, download **App Manifest → Download** again and replace `app-manifest.json`. Update the separate display/iframe settings, logo hash, and portable template when they change. Keep exact installation IDs and routes in the local Library backup. Read the plugin's public CLI status to refresh that backup; do not copy private settings, tokens, activation codes, or preview access links into these public files.

## Launch from another channel or a DM

The launch form offers Project, destination, harness, model and task. Slash commands and unconnected mentions can reply in the calling internal channel when both the linked owner and bot are members. The Project connection supplies the machine and sharing policy; per-task choices do not rewrite its defaults. Shared/external channels, group DMs and other people’s DMs are excluded.

Set **Interactivity → Options Load URL** to `https://zana-ide.com/api/slack/events/`, matching the request URL. External model selects use this callback; without it Slack can display an empty model menu. This callback was configured and verified live on 2 October 2026.

[app-manifest-dm-launch.json](app-manifest-dm-launch.json) is the minimal prepared DM expansion. It adds only `im:read`, `im:history`, `message.im` and the Messages tab, preserving current app settings and the model callback. Review the permissions, save the manifest and reinstall before testing a synthetic owner DM. It does not activate native agent view or Canvas. DM permissions are now active through the agent-only activation; Canvas remains disabled.

## Replies without another mention

[app-manifest-thread-replies.json](app-manifest-thread-replies.json) is the minimal expansion for plain replies in established Zana channel threads and matches the updated recorded manifest. It adds only bot events `message.channels` / `message.groups` and scopes `channels:history` / `groups:history`. The user approved this expansion, Slack approved its workspace request, and Zana was reinstalled in Internal-Sandbox on **3 October 2026**. Real plain replies in both a public and a private channel continued their original agents, retained remembered numbers, delivered one answer each, and removed temporary status messages. Screenshots confirmed the clean chat presentation.

Slack grants message access in channels the bot has joined; gateway and plugin accept only the original launcher’s replies in an existing, authorized conversation. Other messages are dropped without storing their content. Private DM/agent view was activated separately on 4 October; Canvas remains unactivated. Resend a reply missed before activation; Slack did not deliver it. If its agent has since been deleted or archived, launch again with `@Zana` first.
