# Enable Zana task websites in Slack

Prepared for plugin 0.4.0 on 27 September 2026.

The implementation is ready locally. The remaining deployment input is a public HTTPS hostname and a tunnel or reverse proxy for it. The dedicated listener runs on the computer hosting the **plugin receiver**. It serves one authorized task at a time. Agents can still run on their mapped execution machine.

## 1. Preview it without publishing anything

Open **Zana → Zana for Slack → Task website in Slack → Prepare local preview**, then **Open sample task website**. This starts the dedicated listener at `127.0.0.1:8792` and displays synthetic content at `/demo`. It does not start an agent, expose a port on the network, or display a real task. If the port is occupied, stop the conflicting service or configure a different task port with your HTTPS origin.

The responsive page shows the task title, state, concise answer, attention notice, last refresh, and a conversation link. The sample is static. Authorized real views refresh every ten seconds; network failures visibly retain the last snapshot until access expires, at which point the page clears it. Permissions/questions remain in Zana, and launch/stop controls remain in Slack Home.

## 2. Prepare one HTTPS hostname

Use a dedicated hostname such as `tasks.example.com`, with a valid public certificate. Route it only to `http://127.0.0.1:8792` on the receiver machine. Do not proxy the full Zana application or its `8780`/`8781` API. No change to Zana’s authentication or frame protections is needed.

For a Cloudflare locally managed tunnel, [deploy/cloudflared.example.yml](../deploy/cloudflared.example.yml) supplies the exact ingress shape: one hostname → the task listener, followed by a catch-all 404. Set up the tunnel and DNS in your own account, put its credential file outside the plugin/project, copy and fill the template, and validate before running it. This repository contains no tunnel credentials. The official [configuration reference](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/configuration-file/) describes the schema and validation commands.

```sh
cloudflared tunnel --config /absolute/path/zana-tasks.yml ingress validate
cloudflared tunnel --config /absolute/path/zana-tasks.yml run REPLACE_WITH_TUNNEL_UUID
```

The template is prepared, not deployed or CLI-validated on this machine: `cloudflared` is not installed here. Any reverse proxy meeting the same origin contract can be used instead. Choose the hosting account and hostname before publishing. Keep that service and Zana running for live previews.

Configure the edge to preserve `Cache-Control: no-store`, avoid caching `/view/*`, and omit/redact query strings from access/error logs and analytics. The preview URL contains a short-lived bearer credential. Do not add third-party scripts, assets, analytics, service workers, or redirects to the task origin. An intermediary terminating TLS can see task responses, so choose a hosting provider appropriate for the intended tasks.

The endpoint needs no cookie login. A separate edge login page may not work inside Slack’s sandbox; use the task capability checks provided by this plugin and leave Slack’s default null-origin policy enabled.

## 3. Configure the Slack app

Open your Slack app’s settings and choose its rich-preview configuration.

1. Under **Work Object Previews**, enable the **File** entity type (`slack#/entities/file`). Zana represents a task’s view as a file-style Work Object, with display type “Agent task”.
2. Add the **exact hostname** to the embed-domain allowlist. No broad wildcard is needed. Leave same-origin iframe access disabled.
3. Under **Event Subscriptions → Subscribe to bot events**, add `entity_details_requested` and save. Retain `app_mention`, `app_home_opened`, Socket Mode, and Interactivity.

The source manifest includes the new event. Updating that local JSON does not update an already-created Slack app. The Work Object type and embed hostname are configured separately in Slack’s UI. No new OAuth scope is required for the details method. [Event reference](https://docs.slack.dev/reference/events/entity_details_requested/), [details method](https://docs.slack.dev/reference/methods/entity.presentDetails/).

Slack documents embeds for a non-distributed app in its own workspace. Marketplace distribution has separate pilot requirements. That eligibility does not establish that this particular app has accepted a live embed; verify the last step below. [Slack embeds](https://docs.slack.dev/messaging/work-objects-embeds/).

## 4. Save the plugin’s website setup

In **Zana for Slack → Task website in Slack → Set up the Slack website**, save:

| Field | Value |
| --- | --- |
| Public HTTPS address | `https://YOUR_HOSTNAME` — origin only |
| Local task port | `8792`, or the port your proxy targets |

The plugin accepts a DNS hostname over HTTPS without credentials, path, query, fragment, or custom public port. It rejects loopback/IP/local names and Slack domains. It never fetches that origin during setup. “Local endpoint running” confirms the listener; it does not claim DNS, TLS, proxy, or Slack iframe success.

Validate the public boundary without any bearer URL:

```sh
curl --fail --silent --show-error https://YOUR_HOSTNAME/health
curl --silent --output /dev/null --write-out '%{http_code}\n' https://YOUR_HOSTNAME/api/v1/threads
```

Expect `{"ok":true,"service":"zana-task-embed"}` and `404`. `/demo` must show synthetic content. `/view/<uuid>` without its key must return `403`; an unknown path returns `404`. No product API should be reachable through this hostname.

## 5. Verify one Slack card

In the private `slack-bridge-demo` channel, ask Zana for a harmless greeting. Once the binding exists, a normal status update attaches the Work Object to that existing message. Old settled cards are not mass-republished by saving setup. To update an existing demo conversation without model work, mute then unmute its updates from Home; the normal status-card update path is reused.

Click the Work Object card as the linked owner. The expected sequence is:

1. The receiver ACKs `entity_details_requested` immediately.
2. It verifies workspace, app, owner, opaque task ID, exact canonical URL, current mapping and sharing state, internal channel, and active non-guest member.
3. `entity.presentDetails` receives a new task-scoped URL valid for five minutes.
4. Slack opens the page in its side panel, and the page refreshes every ten seconds.

Check a delivered answer, no-answer state, and conversation navigation. Then disconnect or mute: the next refresh must close access and clear displayed task content. Reopen after reconnect/unmute to get a fresh URL. Leaving a page open beyond five minutes must clear it even if the receiver is offline. Test on Slack desktop and mobile; both remain deployment acceptance checks until observed.

The plugin status includes `embed.lastPresented` after Slack accepts the details API response. That is **not** proof the iframe loaded. A metadata rejection disables further Work Object metadata for that connection/configuration and retains normal status delivery. Save website setup after correcting Slack settings. Network-ambiguous message sends are never repeated as a fallback.

## Access and data boundaries

- The public service has only GET routes: `/health`, `/demo`, `/tasks/<opaque-id>` (generic instructions), and `/view/<opaque-id>?key=…` (authorized HTML or JSON). All other paths fail. No arbitrary website, filesystem path, execution API, or proxy target is accepted.
- A 256-bit random capability is issued only through the owner-authorized Slack event. Only its SHA-256 digest and scoped authorization context are held in memory. Nothing is persisted in the plugin DB or emitted by the status command. Links are bearer credentials: anyone who obtains one can read that single task until expiry/revocation. Slack ownership is checked at issuance, not re-proven by each browser request.
- Every read rechecks enabled state, owner/installation, route policy, task existence and mute/archive/delete state. Configuration changes, disconnect, plugin reload and mute revoke existing grants. Slack account/channel eligibility is checked when opening the card, with a maximum five-minute grant lifetime thereafter.
- Only the title already supplied through Slack, task state, mapped channel name, and latest **confirmed sent** concise answer are projected. Status-only routes omit agent-authored answers; manually shared answers remain eligible. Queued, failed, uncertain and raw thread/tool output are excluded. A later completed turn with no answer may still show the previous shared answer, clearly labeled with its sharing timestamp.
- The page uses text escaping/textContent, nonce-based CSP, Slack’s three frame ancestors, no cookies, no-store responses, no-referrer, and anonymous CORS for already-authorized JSON reads in Slack’s null-origin iframe. Main application CSP remains unchanged.
- Capacity is bounded: 32 simultaneous HTTP connections, 60 HTTP requests/second globally, 5-second request/header timeouts, 4 KiB headers, 1 KiB URL, 2 concurrent details requests, 100 deduplicated triggers/5 minutes and 256 in-memory grants. The shared answer query returns one row from the retained outbox. Reload closes all listener connections.

## Disable or troubleshoot

**Disable task website** closes its listener and ends its grants. Stop the tunnel separately to remove the external hostname route. Ordinary Slack Home, mentions, answers and agent control continue to work without the website.

| Symptom | Check |
| --- | --- |
| Local port cannot start | Another process owns the chosen port; choose a different unused port and update the proxy. |
| Card stays ordinary text | Confirm website setup, a subsequent task status update, supported File entity, and no metadata rejection in plugin status. |
| Card opens without a website | Check exact embed hostname, `entity_details_requested`, valid public TLS, CSP preservation and details error. |
| Access ended/expired | Reopen the card while connected as the linked owner with an enabled mapping. Do not reuse old bearer URLs. |
| Connection lost | Zana or the proxy is unavailable; the page keeps a labeled old snapshot only until its access deadline. |
| Public URL shows Zana’s whole UI | The proxy targets the wrong port. Remove that route and point only at the task listener. |

No domain, tunnel or public exposure is created by installing this release. The local preview and implementation can be reviewed independently of deployment.
