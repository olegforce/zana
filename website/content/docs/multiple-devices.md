# Using Zana on multiple machines

Zana Connect gives an instance one address, such as
`your-name.zana-ide.com`. Open that address from another browser, or select
the account-owned instance under desktop **Remote access**. Those clients
use the primary instance's records. The primary computer must stay running;
connecting a second client does not copy or relocate the server.

Multi-machine sharing is being qualified. The current implementation supports
account-bound machine enrollment, shared desktop selection, project checkout
sources, Modern thread routing, ordinary terminals and files/Git on the selected
machine. Public two-machine recovery and rollout qualification remain open.

For the first release, **CLI Agents and Squad/Team workers execute on the primary
machine**. You can control them from the shared interface on another device.
Their definitions and history stay shared. Launching those workers on a secondary
machine, or spreading a Squad/Team across machines, is deferred; choose a project
on the primary for those launches. Modern threads can use registered secondary
machines.

To add execution capacity to that same instance:

1. On the primary, enable **Remote access**, then open **Settings → Machines**
   and choose **Add a machine**. Use its Connect installer on the other computer.
2. The installer pairs a host with this instance. It preserves the existing
   address and creates an isolated daemon under `~/.zcc-machines/<instanceId>`.
   An independent Zana installation on that computer keeps its own data.
3. In the existing project's settings, add its checkout on the other machine.
   The project keeps its ID and history; each machine has its own absolute path.
4. Choose the machine before starting a Modern thread. An offline machine or
   missing checkout produces an error. There is no fallback to another machine.

Checkouts are not synchronized automatically. Git or another explicit file
transfer workflow moves code between them. Repository instructions and provider
credentials belong to the execution machine; project metadata has one canonical
owner. Library remains at the original project location, so that host must be
reachable when it owns the metadata.

Library files and folders can be moved between projects or between a project and
the global Library. Both owners must be reachable. Zana verifies the destination
before removing the source and preserves document identities and binary files.
An interrupted transfer resumes when Library refreshes; conflicting external
edits preserve the files and report a recovery problem. A transfer is limited to
1,000 entries and 64 MiB.

If a Goal or Schedule shows **Check worker**, that action checks the instance's
session inventory and durable launch records. It can reattach a known worker or
resolve a confirmed exit or a launch that never started. It leaves work paused
and never starts a replacement. Missing or ambiguous evidence remains blocked.

Installed plugins use the shared instance. Older plugins that require the native
module bridge are listed as **Owner desktop** in shared clients; use or manage
them on that computer. New plugin installation also remains on the owner's
desktop. Supported installed plugins remain available through the shared client.

Use **Pair again** to repair an enrolled Connect machine while retaining its
host ID. Removing one machine revokes its execution access. Removing an extra
checkout keeps the shared project, history and files; active work must stop first.
Creating another independent instance in the account dashboard is a separate
operation with separate records.

The existing compatibility paths remain available:

- **Enrolled machines** run a host daemon. The other box outbound-connects to
  this app. Add a folder on that machine from **Settings → Machines** (or the
  host picker when adding a local project). Threads then execute there.
- **SSH remotes** are a project folder on a host from `~/.ssh/config`. **Add
  remote** registers the project only. Install the host daemon from composer
  **Install** (or Settings → Machines). Composer Send waits until the daemon
  is bound and online. The env chip shows `user@host · path · Online`. This
  machine's host daemon must be connected (it owns `~/.ssh` for the install).

Copy-paste join remains for boxes you cannot SSH to from this machine.

Connect execution-machine credentials are distinct from browser/phone access.
Browser and phone credentials cannot call host-internal routes. The Connect
machine transport carries enrollment, host WebSocket, authorized tool callbacks
and installation artifacts through a closed route inventory. See
[implementation contracts](./shared-instance-contracts.md) for the boundary.

---

## Legacy machine relay reachability

The product server still binds **loopback** (`127.0.0.1`). Another computer
cannot enroll against `http://127.0.0.1:<port>`. Official desktop builds carry
the public Heroku origin and relay token (inlined at `electron-vite build` from
`ZCC_APP_URL` and `ZCC_RELAY_TOKEN`). This laptop dials
`wss://<origin>/_zcc/relay` — Heroku never inbound-connects to the laptop.

Precedence: runtime env, then the values baked into that build, then
**Settings → Machines → Public app URL**, then the repo `public-app-url`
file. `pnpm dev` seeds `ZCC_APP_URL` from that file when the env is unset.
Do not commit the token; set the same `ZCC_RELAY_TOKEN` on Heroku and in
the release/CI environment (GitHub secrets `ZCC_APP_URL` / `ZCC_RELAY_TOKEN`,
or put them in gitignored `.env` for local `pnpm dev`). The public dual-arch
build is produced by pushing a `vx.y.z` tag.

The token authenticates a laptop to open a session. Isolation between laptops
is the session URL (`/t/<sessionId>`), not a personal key. Join/enroll through
that id stays open while this laptop’s relay is connected. The join hint
renews in the background so Install / Fix never hit a closed window. Host
websockets keep working until this app quits. If the laptop tunnel drops,
join/enroll return `relay_offline` until Zana reconnects.

Join commands use `https://<origin>/t/<sessionId>` so remotes route to the
right laptop.

If the origin is baked/set but the tunnel is down, Install fails with
`relay_offline` (keep Zana running). Dev builds without those env vars stay
loopback; use SSH reverse-tunnel pairing.

That origin is used in the join command and as the **Host-header allowlist**
on the laptop (enroll, host websocket, `/install.sh`).

The Heroku dyno has a separate **path allowlist** (`website/relay/allowlist.json`,
mirrored in the product server): `/install.sh`, `/install/version`,
`/install/zcc-host.tgz`, enroll, interactive-request (and interrupt), and
`/internal/hosts/ws`. Other product HTTP — including `/internal/hosts/tool-call`
— is not relayed.

Operator detail for the front door (`ZCC_RELAY_TOKEN`, `node relay/front-door.mjs`)
is in [`website/README.md`](../website/README.md).

Keep the product server on loopback and use the authenticated pairing relay.
Exposing its port directly would put an unauthenticated control plane on a network.

The machine-pairing URL serves enrollment and host traffic. Use Zana Connect
through **Remote access** for authenticated browser and phone access at your
personal address. SSH reverse-tunnel copy-paste (below) remains the offline
fallback for machine enrollment.

---

## Legacy installer and SSH enrollment

1. Open **Settings → Machines** and choose **Add a machine**.
2. Copy the one-line installer. It looks like:

```bash
curl -fL ${publicAppUrl}/install.sh | sh -s -- \
  --join-code <zcde_...> --host-id <id> --server ${publicAppUrl}
```

3. Run it on the computer that should execute work. The join code expires in
   **15 minutes** and can be redeemed once. The Machines list turns the new row
   online when the daemon's websocket is open.

If the machine is an SSH host (for example `limited-pony`) and you have
not set a public app URL, Add machine copies a **laptop-side** command instead:

```bash
ssh -o ExitOnForwardFailure=yes -R 18782:127.0.0.1:<zcc-port> limited-pony \
  'curl -fL … http://127.0.0.1:18782/install.sh | sh -s -- --join-code … --host-id … --server http://127.0.0.1:18782'
```

Paste that in a terminal **on this computer**. It reverse-tunnels product HTTP
to the remote host and runs the installer there. Leave the SSH session open so
the daemon can keep that tunnel. The installer looks for **Node 22+** on PATH,
then nix / nvm / fnm / volta (a Node 20 PATH entry is skipped). Override with
`ZCC_NODE=/path/to/node`.

The installer requires **Node.js 22 or newer** on the remote box. Manual
pairing downloads the host-daemon tarball from `/install/zcc-host.tgz`. Composer
**Fix** (enrolled machines that are offline) pipes that same tarball over SSH
from this machine instead of asking the remote to `curl` it.

Each legacy joined server gets its own daemon instance and data directory
(`~/.zcc-machines/<server-host>`); Connect uses the durable instance UUID above.
Joining never touches a full local install's
`~/.zcc`. Subsequent runs reuse the reserved local API port under
`~/.zcc-machines/host-daemon-ports/`; pass `--host-daemon-port <port>` to
override.

On macOS the installer loads a LaunchAgent. On Linux it enables a systemd user
unit when that bus is available; Salesforce workspaces and other boxes without
user systemd keep the daemon running in the background instead of hanging.
Both start the daemon with `--auto-update`.

---

## Fix from the composer

When an already-paired machine is offline, the composer shows **Fix**. If Zana
stored an SSH alias for that host, Fix restarts the LaunchAgent or systemd user
unit and reinstalls if restart does not reconnect. If no SSH alias is stored,
Fix asks you to pick a host from `~/.ssh/config`, then retries.

Fix needs a public origin (baked into the official app, `ZCC_APP_URL`,
Settings, or the repo `public-app-url` file), not loopback. This machine's
host daemon must be connected — it owns `~/.ssh` and performs the SSH. If SSH
cannot run, copy the Settings → Add machine join command.

**Add remote project** registers the SSH project only. Composer **Install**
enrolls a host daemon over SSH and stays available until a daemon is bound.
Send is blocked until that daemon is online. If SSH cannot complete the
install, retry from the composer or copy the reverse-tunnel command.

---

## After it connects

1. **New project** — pick the machine in the host picker and browse its disk
   (or paste a path on that box).
2. **New thread / home composer** — pick the machine when more than one host is
   connected, or when an enrolled machine is offline (Online/Offline in the
   picker). A project remembers the host it was created on.
3. **Provider CLIs** — each machine row lists Codex / Claude (and other)
   CLI install state. Use **Update all** when any enrolled box is missing or
   outdated.
4. **Permission ceiling** — Settings → Machines can cap that box at accept-edits
   or auto. Owner-session only; a thread cannot exceed the ceiling.

Machine names are labels and may be duplicated; the host id is the stable
handle. The laptop that runs the product server is the **primary** machine and
cannot be removed from the list.

---

## Local Docker trial

A Linux box lives in `docker/remote-machine`. It is
the same enroll path as a real remote: Node 22, `/home/zcc/workspace`, SSH on
port 2222, no systemd user bus (the installer nohups).

Start it and leave it idle:

```bash
pnpm docker:remote-machine
```

Then either paste the Settings → Add a machine command inside the box:

```bash
docker exec -it zcc-docker bash
# or: ssh -p 2222 zcc@127.0.0.1   (password: zcc)
zcc-join --join-code <zcde_...> --host-id <id> --server <url>
```

Or mint and enroll in one step (`pnpm dev` must be running). If the laptop
relay is connected, this uses `https://<origin>/t/<sessionId>`; otherwise it
publishes a loopback proxy so Docker can reach `127.0.0.1`:

```bash
pnpm docker:host-daemon
```

Force a door with `--relay` or `--local`. Prove a Linux box can enroll through
the session join URL with `pnpm test:docker:pairing` (needs Docker). Stop with
`pnpm docker:remote-machine down`.

Settings → Machines should show hostname `zcc-docker`. Add a project at
`/home/zcc/workspace` (sample app is in the repo under
`docker/remote-machine/workspace`). This is a local pairing trial.


---

## Self-update

If session open reports a newer server protocol, the daemon downloads the
server artifact, updates its private install, then exits so launchd/systemd
restarts it. Failed attempts fall back to reconnect with a persisted backoff
from 5 seconds to 5 minutes. **Retry update** in Settings → Machines bypasses
the current backoff. A daemon never downgrades itself to an older protocol.

To opt out, remove `--auto-update` from the LaunchAgent plist or systemd unit,
then reload the service.

---

## Where to go next

- **[Getting started](./getting-started.md)** — first project and first agent.
- **[Using Zana](./using-zana.md)** — Inbox, Agents, and the
  day-to-day surfaces.
