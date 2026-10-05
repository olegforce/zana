# Shared Slack bot through Zana Connect

Added in 0.7.0. The code is implemented; hosted activation still requires the matching server deployment and Slack app configuration. Your existing direct Socket Mode connection is retained until you explicitly link through Connect.

## Connect your own computer

1. In Zana, open **Settings → Phone → Zana Connect**, sign in and connect this computer. Enable phone access so the outbound tunnel is available. You do not need to pair an actual phone.
2. Open **Zana → Home** in Slack and choose **Connect my computer**. Sign in with the same Connect account. Verify the displayed Slack identity and workspace, then select this computer.
3. Open **Plugins → Zana for Slack → Configuration → Connection settings → Connect your Slack account** on the selected computer. Paste the activation code and choose **Approve Slack access on this computer** within ten minutes.
4. Configure the Projects and channels this Slack user can use. Each mapping still chooses its execution machine, provider/model and answer-sharing policy.

No Slack bot tokens need to be copied to user laptops. The plugin stores a private, revocable Connect link credential. The cloud probes the chosen computer during activation, so a code entered on another machine cannot finish setup. Keep your computer awake with Zana and the shared tunnel running.

Each Slack user has one selected computer. A replacement becomes active only after local activation. Previous Slack conversations remain bound to the original link and cannot silently jump to a replacement computer. Start a fresh conversation after changing computers. Channel participants see shared tasks and answers, but only the linked owner can control them.

## Controls and feedback

Your existing Home, Project picker, mentions, `/zana` shortcuts, status cards, stop/mute controls and concise-answer delivery continue through the same plugin logic. Permissions and questions remain in Zana. Only channels joined by both you and the bot are exposed, and shared/external channels remain unavailable.

- **Disconnect** pauses this plugin's receiver; existing agents keep running.
- **Connect** resumes the saved direct or Connect connection.
- **Unlink Zana Connect** revokes the cloud grant, clears the local grant and removes channel mappings. If central revocation fails, the grant stays locally visible so you can retry. You can also revoke access from the Connect account page.
- Incoming task receipts and outgoing Slack delivery remain separate in **Diagnostics**. “Sent” means Slack accepted the message, not that somebody read it.
- Offline computers do not accumulate tasks for surprise execution on wake-up. An interrupted dispatch is marked unconfirmed; inspect Zana before sending it again.

## Service configuration

Use the accompanying `slack-app-connect-manifest.json` for a hosted HTTP receiver. Its default URL is `https://zana-ide.com/api/slack/events/`; change it if you host Connect elsewhere. Configure the same endpoint for Events, Interactivity and `/zana`. The existing `slack-app-manifest.json` stays the direct Socket Mode variant.

The Connect deployment needs `SLACK_APP_ID`, `SLACK_TEAM_ID`, `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`, in addition to its existing account/database settings. Credentials live in the hosting secret store. The app token used by direct Socket Mode is not needed by the server. Disable the old direct receiver before switching that app to HTTP delivery.

The server implementation and complete rollout/rollback instructions live in the Zana repository's `docs/slack-connect.md`. The service uses the existing single-process Connect tunnel routing, verified Slack signatures and account-bound dispatch. It currently supports one Slack installation/workspace per server configuration, with many individually linked users.

## Current limits

Work Object iframe presentation is not supported through the shared proxy yet; Home and normal status cards work. Native `/zana` requires its Slack scope/install approval. The proposed mention-prefixed `/project-list` language and favorite-harness fallback are separate UX proposals, not part of this transport change.

The cloud keeps receipt metadata for one day and conversation ownership for up to 90 days. Start a new task conversation after the route expires. Membership lookup is bounded to 1,000 channels; an unmatched channel is rejected. Agent output reaches Slack only according to the local sharing policy; task prompts and selected summaries pass through the Connect service in transit.
