# Using Zana in Slack

Practical guide · Zana for Slack 0.14.2 · Updated 2 October 2026

Zana lets you start work on your connected computer from Slack, follow its progress, and continue the conversation where the task began. Use **Slackbot** for natural-language requests, **@Zana** in an internal channel where the app is invited, **/zana** for shortcuts, or **Zana Home** for buttons and a dashboard.

The Slack app is called **Zana**. Its settings in the Zana desktop app are under **Plugins → Zana for Slack → Configuration**.

For the shared Zana app, you do **not** enter a Zana API token, Slack app ID, app-level token, or bot token. Setup uses your connected account and a one-time activation code. Once linked, that code disappears. The service address is under **Advanced connection settings** and normally stays at its default. **Advanced: use your own Slack app** is only for a separately managed Socket Mode app; those credentials remain available for that setup.

## Choose how to start

| Where you are | Use this | Example |
| --- | --- | --- |
| Talking to Slackbot | Ask it to use the Zana app | “Use Zana to review the tests in My Website.” |
| In a connected Project channel | Mention Zana | `@Zana Review the tests and share a short summary.` |
| You want to choose a Project in a form | Run the slash command | `/zana` |
| You want an overview of your tasks | Open Zana → Home | Choose **New agent** or **Open conversation**. |
| Continuing existing work | Reply in its Slack thread | `@Zana Now add a test for the edge case.` |

**A new task creates a Zana agent conversation. A follow-up in its Slack thread continues that same conversation.** The Project connection determines the execution machine and sharing policy. The launch form prefills its harness and model, and lets you choose another available harness/model for that task. Follow-ups keep the same Project, machine, harness, model, and Slack thread.

## Use Zana without opening a Project channel

You can start from another place in Slack today:

| Starting point | What to do | Where the job conversation goes |
| --- | --- | --- |
| **Slackbot** | Ask “Use Zana to review the tests in My Website.” Ask Slackbot for the job's status afterward. | The Project's selected connected channel; Slackbot can retrieve progress and the confirmed shared answer. |
| **Another internal channel** | Invite Zana, then use `/zana` or mention `@Zana <task>`. A task mention starts immediately using your mention default, including inside an ordinary existing Slack thread. Use `/zana` to select another Project, harness or model. | **Here — the conversation you called Zana from** is selected by default; you can choose a connected Project channel instead. |
| **Zana → Home** | Choose **New agent**, then a Project, destination, harness and model. | The selected connected channel. |
| **A DM with the Zana app** | After the app has DM permissions, use `/zana` or send a task and choose **Start with Zana**. | The owner’s verified DM; follow-ups can be plain replies in its task thread. |

The Project selects the code/context and execution machine. The destination selects where the task and enabled answers are shared. A connected Project still supplies authority and sharing consent; the caller channel itself does not need a saved Project mapping. You and Zana must both be members of an internal destination channel. If Zana is absent, accept Slack’s invitation prompt when mentioning it; Slack does not deliver the mention until the app is invited. Shared/external channels and group DMs are excluded.

In a connected channel, a direct mention uses its saved defaults immediately. Use `/zana` when you want to choose the harness or model. In an unconnected channel, a task uses **Default Project for mentions** from the plugin settings, or the connected built-in Default Project. If no default is connected, it offers the Project/profile picker. A bare `@Zana` offers the task form; a bare mention in an existing Zana task shows status. Status messages are plain text; Stop, Mute and Open in Zana controls stay in Home. Starting another job creates a separate conversation. Slackbot can also honor a requested harness/model: it discovers available IDs with `zana_launch_options`, then includes them in `zana_launch_job`. Its destination remains an approved Project channel.

**DM activation:** the implementation and gateway are ready; the live Slack app still needs the minimal DM manifest and a reinstall granting `im:read` and `im:history`. These permissions allow messages to the bot; they do not enable the separate native agent view or Canvas feature. See [the configuration guide](slack-configuration/README.md).

### Use @Zana in an existing channel with Default Project

An existing internal channel can keep its normal name and purpose and use **Default Project** behind the scenes. Configure it once:

1. Add the Zana app to that channel. You must also be a member, using your linked Slack identity.
2. In Zana, open **Plugins → Zana for Slack → Configuration → Connected Projects → Connect another Project**.
3. Choose that Slack channel and **Default Project**, then select the execution machine, provider, and model. Enable agent answers if you want replies shared in Slack, and save the connection.
4. In the channel, send `@Zana <your task>`. Zana uses Default Project and replies in the same Slack thread. Mention it in that thread for follow-ups.

This does not create or rename a channel. You can connect more than one existing channel to Default Project. Channel members can see its posted answers, while only your linked identity controls your jobs. Shared/external channels remain excluded. Unconnected internal channels offer a Project picker instead of silently selecting Default Project.

**Live verified on 30 September 2026:** [#test-channel-by-gui](https://internal-sbx.slack.com/archives/C0C6M1UARDW/p1790800521518869?thread_ts=1790800521.518869&cid=C0C6M1UARDW) was connected to Default Project through this settings form. A mention returned `DEFAULT-PROJECT-OK-27`; a follow-up asking to add 15 to the remembered number returned `42`. Both used the same Zana session and replied in the original channel thread. The mapping remains configured for the linked owner.

**Harness/model choices were live-verified on 2 October 2026:** a task selected Cursor → grok-4.6 and returned “Harness selection works” in Slack, while the Project default remained Codex → gpt-6-astra.

## 1. Connect your own Zana account and computer

If your connection already says **Connected**, skip to importing Projects.

1. Connect your computer to Zana Connect and set up your personal address, such as `my-domain.zana-ide.com`. In current Zana builds, start in **Settings → Remote access**; older instructions may call this **Phone → Zana Connect**. Keep remote access enabled.
2. In Slackbot, enable/select **Zana** under **Apps**, then ask:

   > Connect Zana to my-domain.zana-ide.com.

3. Open the private connection link. Sign in with the account that owns your domain and check the displayed Slack identity and computer.
4. Follow the handoff to **Plugins → Zana for Slack → Configuration → Connection settings → Connect your Slack account**. Paste the short-lived activation code and choose **Approve Slack access on this computer**.
5. Confirm the bridge is connected. Keep Zana running and the selected computer awake.

You can also start linking from **Slack → Zana → Home → Connect my computer**, or use `/zana connect my-domain.zana-ide.com` with the hosted integration. `/zana connect` opens setup without choosing a domain first.

Each person connects their own account and computer. Installing the shared Slack app does not give everyone access to your machine. If you change the linked computer, start a fresh task: existing conversations stay associated with their original connection.

## 2. Import the Projects you want in Slack

Connecting your computer does **not** import all Projects. You choose which ones get a Slack channel.

In Zana, open **Plugins → Zana for Slack → Configuration**:

1. Set and save **Import defaults**: machine, provider, model, answer sharing, and an optional channel prefix.
2. Select the Projects you want.
3. Choose **Import selected**.

Importing creates a private channel for each selected Project and adds you and the Zana app. It does not start a job. Repeat imports reuse the managed channel.

| Your settings | Example channel |
| --- | --- |
| Project `My Website`, no prefix | `#zana-my-website` |
| Same Project, prefix `demo` | `#demo-zana-my-website` |
| Name already taken | A suffix is added to resolve the collision. |

To import from Slack, first enable **Allow imports from Slack** in the import settings. Then ask Slackbot:

> Show my Zana Projects and which ones are imported.

> Import My Website into Slack using Zana.

Or use:

```text
/zana import
/zana import "My Website"
```

The first lists available Projects; the second imports the named Project. Exact Project IDs also work when names are ambiguous. Browse/import controls must be enabled under **What Slack can do**.

You may also use an existing approved channel through **Manage connected channels**. Each mapping selects its Project, machine, provider/model, and answer-sharing policy.

Slack's custom sidebar sections are personal. You can manually create a **Zana** section and move your Project channels into it; the bridge creates the channels, not that sidebar section.

## 3. Ask Slackbot to use Zana

Open Slackbot and make sure the Zana app is available under **Apps**. Be explicit about the Project and task:

> Use Zana to list my connected Projects.

> Use Zana to review the tests in My Website. Do not modify files. Post the findings in its connected channel.

> Use Zana to fix the failing tests in My Website and summarize the changes in its connected channel.

> Check the status of that Zana job.

Slackbot uses your available Project/channel connections. If it asks you to choose a destination or approve using a tool, review that choice. The task then appears in the selected Project channel as a Slack thread.

“Accepted” or “queued” means the request was received. Follow its status card or ask Slackbot to check the job to find out whether it is running, needs attention, or has finished.

For follow-up instructions, open the job's channel conversation and reply with `@Zana`. That is the supported way to continue the same agent session.

## 4. Talk directly to @Zana in a Project channel

Open a connected channel, type `@Zana`, and select the actual app from Slack's mention suggestions. Then describe the task:

```text
@Zana Review the authentication tests. Identify gaps and share a concise summary. Do not change files.
```

Zana creates a session and replies in a Slack thread. Continue inside that thread:

```text
Focus on expired sessions and suggest two test cases.
```

Use these controls in the same thread:

| Message | What happens |
| --- | --- |
| `status` | Show the conversation's current status. |
| `stop` | Stop the agent and cancel queued follow-ups for that conversation. |
| `mute` | Silence updates while the agent continues working. |
| `unmute` | Restore new updates. |
| `help` | Show usage guidance. |

A new top-level task with `@Zana` starts a separate conversation. Once the agent is linked, its original launcher can reply in that Slack thread without another mention; other people's messages are ignored. If a turn is still running, a follow-up waits for it to finish. `@Zana` also works for follow-ups and controls.

Plain replies require Slack's `message.channels` / `message.groups` events and `channels:history` / `groups:history` scopes. These were activated and verified in Internal-Sandbox on 3 October 2026. Other installations must activate them and reinstall the app. A deleted or archived agent cannot continue through a plain reply: launch again with `@Zana`. Replies missed before activation must be sent again.

## 5. Use /zana shortcuts

Type slash commands in the channel's **main message composer**, not inside a Slack thread.

| Command | What it does |
| --- | --- |
| `/zana` | Open the Project/destination/harness/model/task form. |
| `/zana run . Review the tests` | Prefill a task for the current channel's Project. |
| `/zana run "My Website" Review the tests` | Prefill a task for a named connected Project. |
| `/zana projects` | List imported/connected Projects and their channels. |
| `/zana import` | List Projects available to import. |
| `/zana import "My Website"` | Import that Project when Slack imports are enabled. |
| `/zana status` | Show activity across your connections. |
| `/zana status .` | Show activity for the current channel's Project. |
| `/zana status "My Website"` | Show activity for a named Project. |
| `/zana connect` | Open connection setup. |
| `/zana help` | Show the supported shortcuts. |

For a launch, check the Project and destination in the form, then choose **Start agent**. Opening the form alone does not launch anything. Quote names containing spaces; use exact IDs when multiple Projects have the same name.

Command replies are visible only to you. Once you submit a task, its prompt and enabled updates appear in the destination channel. To continue or stop that task, use mentions in its thread or the Home controls.

## 6. Use the Zana Home dashboard

In Slack, open the **Zana** app and select **Home**.

- Choose **New agent**, select a connected Project, destination, harness and model, enter the task, and choose **Start agent**.
- Review running tasks, tasks needing attention, and recent conversations.
- Choose **Open conversation** to return to a task's Slack thread.
- Use **Stop**, **Mute updates**, or **Unmute** for a particular task.

The dashboard depends on your current capability settings and an online connection. A previously loaded Home view may be stale while Zana is offline.

## 7. Decide what Slack is allowed to do

Open **Plugins → Zana for Slack → Configuration → What Slack can do** in Zana. Use search or the **All / Enabled / Disabled** filter to find a functionality.

| Switch | Controls |
| --- | --- |
| **Browse Projects** | Listing registered Project names and approved Slack destinations. Required for imports and new launches. |
| **Import Projects** | Creating or reusing a channel for a requested Project, using saved defaults. |
| **Start new jobs** | Starting agents from Slackbot, slash commands, Home, or a new mention conversation. |
| **Continue conversations** | Sending follow-up tasks to existing conversations. |
| **View job progress** | Status, activity updates, and task previews. |
| **Share answers** | Sending new answers and exposing answer previews. Agent answers also require the channel's sharing setting. |
| **Use plugin tools** | Discovering and using individually enabled read-only plugin capabilities. |

Connection, help, stop, and mute/unmute controls remain available. Disabling a functionality does not erase messages already posted or stop an agent already running; use **Stop** when you want to end active work.

Additional plugin tools appear under **Individual plugin tools** only when an installed plugin contributes them. Enable each one deliberately, then ask Slackbot:

> What additional Zana plugin capabilities can I use?

Installing a plugin alone does not expose all of its tools to Slack. The current extension interface exposes approved read-only capabilities scoped to imported Projects.

## Open the custom task panel

In **Plugins → Zana for Slack → Configuration → Custom task panel in Slack**, enable **Enable custom web panels**. With Zana Connect, this uses your existing account connection; there is no extra domain or local port to configure.

Click the **Agent task** card attached to a Zana status message in Slack, or choose **Open in side panel**, to open the custom panel. Cards are added to new task status messages and to existing ones when their status next updates. The panel displays the task title, channel, live state, and latest answer already confirmed as delivered to Slack. Fenced code blocks have a separate language label and preserve the code as plain, selectable text. It refreshes every ten seconds while your computer is connected.

**Disconnect versus unlink:** Disconnect pauses access and keeps your selected Projects. Unlink clears Project imports, mappings, import defaults and plugin tool permissions. Existing agents and local history remain in Zana, but their old Slack task cards cannot control or preview them after relinking. Choose Projects and permissions again, then start a new Slack conversation.

If the computer loses its connection, the panel marks its last snapshot as disconnected and retries. Access still expires after five minutes, including when the panel is suspended; reopen the card after reconnecting. Shared answers and code examples are limited to 2,000 characters; oversized submissions are rejected, not silently cut off.

Only the linked task owner can request a private panel. Its access lasts five minutes; reopen the card to continue. Muting the conversation, disabling the panel or status sharing, changing the relevant sharing policy, or disconnecting Zana ends existing access. Agent permission requests remain in Zana. The panel does not expose files, tool output, or the complete transcript.

For app maintainers: enable Work Object Previews with the `slack#/entities/file` type, allow the exact hostname `zana-ide.com`, and subscribe to `entity_details_requested`. Keep `allow-same-origin` off. This event requires no additional OAuth scope. See [Slack's embed documentation](https://docs.slack.dev/messaging/work-objects-embeds/).

## 8. Understand answers, code, and access

**Answers:** Slack receives a status card and, when enabled and supplied by the agent, a concise answer. It is not a live copy of the entire terminal or conversation transcript. Published agent answers currently have a 2,000-character limit. Ask for a short summary and open Zana for longer results or files.

**Desktop panels:** Slack-controlled agents are told that you cannot see Zana's side panels. Builds with [remote presentation support](remote-conversation-presentation.md) also block agent calls that open file previews, presentation terminals or browser panels. Background browsing and execution remain available. The current Slack task panel shows shared answers; it does not display arbitrary project files. Requested web previews may use an authenticated, reachable preview link. Simply viewing the conversation in Zana does not transfer control away from Slack.

**Code:** You can ask for a short code example and have it shared in the thread:

```text
@Zana Show a tiny JavaScript add function in a code block and share it here. Do not modify files or run commands.
```

A live test in BT Internal Sandbox confirmed a code block with a Copy button, preserved indentation, and an inline example. There is a known formatting issue: a fence language label such as `typescript` appears as the first code line, with no syntax highlighting. For a clean basic snippet, ask for a code block **without a language label**. The custom task panel separates fence language labels from the code. Syntax highlighting and downloadable code attachments are not implemented.

**Visibility:** Channel members can see posted task prompts and shared answers. Only the linked owner can control their bridge conversations. Permissions and agent questions stay in Zana; open Zana when a task needs your input.

**Scope:** These entry points launch individual agent conversations. They do not launch saved Job Teams or automatically mirror every pre-existing desktop session into Slack.

## If something does not work

| Symptom | What to check |
| --- | --- |
| No response to a mention | Select the actual Zana app mention; invite it to the internal channel; confirm you are the linked owner and the computer is awake. |
| The model picker is empty | Wait for the selected harness’s model list to load and search again. Maintainers must configure Options Load URL to the same Slack events endpoint. |
| A Project is missing from the launch picker | Import/connect it first and check **Browse Projects** and **Start new jobs**. |
| Import is disabled | Save import defaults, enable **Browse Projects**, and enable **Allow imports from Slack** / **Import Projects**. |
| A functionality is disabled | Check its switch under **What Slack can do**. |
| A task needs permission or clarification | Open the conversation in Zana and respond there. |
| The task finished but no answer appeared | Check **Share answers**, the channel's answer setting, mute state, and whether the agent supplied an answer. |
| Delivery or launch is “unconfirmed” or “needs review” | Inspect the Slack thread and Zana before retrying, to avoid duplicating work. |
| Slackbot cannot find the Zana app or its latest tools | Check **Slackbot → Apps**. Workspace app/tool configuration may need refreshing by its maintainer. |

For detailed status, open **Plugins → Zana for Slack → Configuration → Diagnostics**. **Incoming requests** tracks what Zana received; **Outgoing delivery** tracks Slack messages. **Sent** means Slack accepted a message, not that the task succeeded or someone read it.

## Check a second person's connection

A colleague needs their own Zana installation, account, and enrolled computer. They link the shared Zana app from Slack, approve their own activation code locally, and import one harmless test Project. They should not copy another person's credentials or activation code.

1. Each person sends `@Zana Reply with my test number: 27. Do not read files or run commands.` in their own connected channel, using a different number for the second person.
2. Confirm each job appears on its owner's Zana computer and in that person's selected Project.
3. Each person opens their own task panel and checks its answer. A different Slack identity must not be able to request that private panel or control the task.
4. Pause one person's bridge. The other person's connection and jobs should keep working. Reconnect and reopen the paused person's task card.

Automated two-owner routing and access tests pass. A trial with two real people and separate computers remains to be completed.

## Try it now in the sandbox

The existing [#zana-slackbot-test channel](https://app.slack.com/client/E04SQG1CF60/C0C5MT2QJAJ) is connected to the `slack-bridge-demo` Project for the currently linked owner. Send:

```text
@Zana Give me a one-sentence greeting and share it here. Do not modify files or run commands.
```

Then reply inside its thread:

```text
@Zana Make that greeting shorter.
```

This exercises a new task, a returned answer, and a follow-up without requesting code changes. A colleague should first connect their own account and import their own Project.

---

Maintainer references: [Slackbot integration](slackbot-app.md), [capability settings and plugin tools](slack-capabilities.md), and [Connect setup](slack-connect.md). This guide describes the current bridge; some older setup documents retain historical rollout notes.
