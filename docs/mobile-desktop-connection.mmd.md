# How Zana Mobile connects to the desktop

**Summary:** The phone does not talk to Electron directly and does not run agents. It talks to a **local mobile gateway** on the computer. That gateway authenticates the device, then proxies the same product UI and APIs the desktop already uses. Work stays on the Mac.

Canonical product doc: `docs/mobile-app.md`. Implementation: `apps/server/src/mobile/gateway.ts`, `apps/server/src/mobile/manager.ts`, `apps/app/src/views/settings/PhoneSettingsView.tsx`, `packages/mobile-bridge`.

## What each side is

| Piece | Role |
| --- | --- |
| **Desktop / product server** | Loopback HTTP (typically `127.0.0.1:8780`). Threads, `/api/v1`, `/ws`, plugins. Agents stay here. |
| **Mobile gateway** | Extra listener on **port 8785**. This is the only thing a phone is allowed to reach. |
| **Zana Mobile** | Expo / React Native **shell**. After pairing, a WebView loads the same renderer as desktop, through that gateway. |

Turn on **Settings → Phone → phone access**. Desktop starts one gateway, prefers a private LAN IP so a real phone on Wi‑Fi can reach it, otherwise loopback (simulator / reverse proxy). `pnpm mobile:serve` is the same gateway for local/dev, forwarding to `:8780`.

The product server itself stays loopback-only. The phone never gets host enrollment, MCP, installer routes, or host credentials.

## Architecture

```mermaid
flowchart TB
  subgraph Phone["Zana Mobile (Expo / React Native)"]
    Native["Native shell<br/>SecureStore · QR · cookies · push"]
    WebView["WebView<br/>same renderer as desktop"]
    Bridge["mobile-bridge<br/>share · haptics · Reload · chrome"]
    Native --> WebView
    WebView -. native affordances only .-> Bridge
    Bridge --> Native
  end

  subgraph Computer["Your computer"]
    GW["Mobile gateway :8785<br/>auth boundary"]
    PS["Product server :8780<br/>loopback only"]
    Agents["Agents / host-daemon / PTY"]
    Store["~/.zcc/mobile/devices.json<br/>SHA-256 hashes only"]
    GW --> PS
    PS --> Agents
    GW --- Store
  end

  Native -->|"1. pair: POST /_mobile/pair"| GW
  Native -->|"2. session: POST /_mobile/session<br/>Bearer device credential"| GW
  WebView -->|"3. pages + /api/v1 + /ws<br/>HttpOnly cookie"| GW
```

## Pairing, then every later visit

1. Desktop shows a QR / `zana://connect` payload: `{ version, serverUrl, code, expiresAt }`.
2. Code is **single-use**, **5 minutes**.
3. Phone posts that code to `POST /_mobile/pair`.
4. Gateway mints a **device credential**, stores only its **SHA-256** in `~/.zcc/mobile/devices.json` (max 20 devices, 90-day lifetime). The secret stays on the phone (SecureStore), never in the WebView JS bridge.

Scanning only fills the form; **Connect** is the actual pair.

Then, on every later visit:

1. Native shell sends the device credential: `POST /_mobile/session` → **HttpOnly** cookie `zcc_mobile_session` (12 hours). Reloading / coming to the foreground renews it.
2. WebView loads `serverUrl` with that cookie.
3. Gateway checks origin/`Host`, then **proxies** allowed paths to loopback.

Revoke a device in Phone settings: credential, cookie, and sockets die; desktop keeps working.

```mermaid
sequenceDiagram
  autonumber
  participant D as Desktop<br/>Settings → Phone
  participant G as Gateway :8785
  participant P as Phone native shell
  participant W as WebView
  participant S as Product server :8780

  D->>G: Enable phone access
  D->>G: pair() → QR / zana://connect
  Note over D,P: payload: serverUrl + one-use code (5 min)
  P->>G: POST /_mobile/pair { code }
  G-->>P: device credential (secret stays on phone)
  Note over G: store hash only, max 20 devices, 90 days

  P->>G: POST /_mobile/session (Bearer)
  G-->>P: Set-Cookie zcc_mobile_session (12h, HttpOnly)
  P->>W: open serverUrl with cookie jar
  W->>G: GET / · /api/v1/… · WS /ws
  G->>S: proxy allowed paths only
  S-->>G: renderer + product API
  G-->>W: same Zana UI, live updates
```

## What the gateway forwards vs blocks

```mermaid
flowchart LR
  subgraph Allowed
    A1["Product pages"]
    A2["/api/v1/*"]
    A3["/ws"]
    A4["/_zcc/bootstrap<br/>/_zcc/health"]
  end
  subgraph Blocked
    B1["/internal"]
    B2["/mcp"]
    B3["/install"]
    B4["host credentials<br/>X-Forwarded-*"]
  end
  Phone[Phone] --> Gateway
  Gateway --> Allowed
  Gateway -.-> Blocked
```

The gateway also does **not** forward caller `Authorization`, phone cookies, or `X-Forwarded-*` to the product server.

## Native bridge (not the connection)

`@zana-ai/zcc-mobile-bridge` is a **page ↔ shell** channel: share, haptics, badge, open Settings, Reload, chrome visibility, “auth required”. It is not how you log in. Device secrets never go through that JS bridge.

Push is optional: Expo token registered on the gateway, which watches thread state even if the WebView is asleep. Payloads are generic (status + route), not prompts or code.

## Connect modes

- **Paired (normal):** QR → gateway → cookie → WebView.
- **Direct:** already-private URL or simulator loopback, skipping pairing.

**LAN:** gateway binds a private IPv4 when it can (`192.168.x` / `10.x` / `172.16–31.x`). **Simulator:** loopback, or `pnpm mobile:serve`. **Off-LAN:** HTTPS reverse proxy / Tailscale in front of `127.0.0.1:8785`; the public origin must match exactly and WebSocket upgrades must be preserved. Product server stays loopback.
