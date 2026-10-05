# Projects in Slack — version 0.5.0

Implemented and verified on 27 September 2026.

## What changed

Zana Home now shows a **Projects** section even when there are no agent conversations. Each connected Project lists its Slack channels and has a **New agent** shortcut. Unconnected local Project names and paths are not published to Slack. The existing demo connection is unchanged.

The launch modal has separate **Project** and **Slack channel** inputs. Selecting a Project shows only its configured channels. Single choices are preselected; when several channels are available the user chooses one. A Project shortcut on Home preselects that Project. Changing Projects resets the channel input while retaining task text.

**Connect another Project** appears on Home and in the launch modal. It explains the three setup steps and provides a local link to `/plugins/slack-bridge-2ff2/main/connect`. On the receiver computer, the link opens the running Zana web interface at its connection form. On a phone or another computer, the user completes setup on the Zana machine instead. Opening setup does not create a connection or change sharing. The user selects a Project, joined internal channel, machine, provider, model and sharing policy before saving.

The desktop section is now **Connected Projects**, with the same **Connect another Project** wording. A Project can have several channels; one channel maps to one Project. Home shows eight Project rows at once and provides a filter for other connected Projects. The existing configuration limit remains twenty channel mappings.

## Implementation decisions

- Home Project rows come from current authorized channel mappings, not the complete local Project catalogue.
- Launch drafts still retain their owner, workspace, app, expiry and connection snapshot. They now also retain Slack's modal ID.
- Project changes use `views.update` with Slack's view hash. Task input IDs stay stable; channel block IDs include the selected Project to clear a previous Project's channel. See [Slack's update and input-preservation contract](https://docs.slack.dev/reference/methods/views.update/).
- Updates validate the owner, installation, modal ID, expiry and current route. Submission validates the Project/channel pair and rechecks the full saved connection policy. Opening or updating a form cannot spawn an agent.
- Existing durable intake, confirmed-root-before-launch, deduplication and uncertain-delivery behavior are unchanged. Old combined-picker forms ask the user to reopen New agent.
- Older installed hosts can redirect a plugin URL to Home before loading its registration. A bounded plugin content-script restores only this exact initial setup URL, on the same origin, after startup effects. It does not take over another destination, accept query/hash payloads, or expose a general navigation endpoint; its timer is disposed on unload.
- No core source change, new Slack scope, public endpoint, or additional Project connection is required.

## Verification

**Automated:** 97 tests across eleven files pass, as does TypeScript checking. Coverage is 92.81% statements, 90.22% branches, 88.83% functions and 94.00% lines. New tests exercise disconnected/empty Home, bounded Project lists, hidden local Projects, multiple Projects/channels, preselection, channel reset, stable task input, forged cross-Project submissions, outdated routes, foreign modal IDs, failed view updates, setup links, startup navigation and disposal.


- Thread: `325942e9-ae89-4c88-a446-94200e2bf540`.
- [Verified Slack conversation](https://zana-wky9354.slack.com/archives/C0C4BK70ZJB/p1790543130848639?thread_ts=1790543130.848639&cid=C0C4BK70ZJB).

**Installed product:** the actual Electron Slack Bridge panel rendered Connected Projects; Connect another Project opened the existing mapping form, and Cancel editing left configuration unchanged. The Slack setup link opened the installed server in Chrome; after the startup handoff fix, a fresh load reached the connection form directly.

**Broader launch regression:** the full mode/reasoning suite finished in 417.26 seconds with 53 passing, one failing and one gated skipped test. The failing case was `cli-agent 'codex executionState interactive' does not crash`, reporting an exit before becoming alive. A focused rerun failed again. A bounded diagnostic run then passed, followed by the unchanged original focused test passing in 1.67 seconds. This is an intermittent startup result; the full run is not recorded as green and no unrelated harness change was made. The temporary diagnostic file was removed.

**Memory:** `live:memory` was invoked; its bodies completed in 37 ms because the required Memory plugin is unavailable. Runner pass rows are not counted as Memory integration verification.

Multiple-Project switching is covered in automated tests; live Slack retained the single existing demo mapping. Website HTTPS/Work Object activation remains a separate, unfinished deployment step described in [Task website setup](connect-setup.md).
