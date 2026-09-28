# Zana Command Center — website

The public face of the app: **marketing landing**, **plugin marketplace**,
**docs**, and **download**.

**Live:** [https://zana-ide.com/](https://zana-ide.com/). Heroku app: `zcc`.

Built with Next.js (App Router) in standalone-server
mode so the site can serve its authenticated publishing API and plugin feed
routes alongside static marketing and documentation pages.

## Run

```bash
cd website
npm install
npm run dev          # http://localhost:4321
npm run build        # production standalone build in .next/
```

## How it connects to the app (no duplication)

| Page | Source of truth |
| --- | --- |
| `/` landing | Curated copy in `app/page.tsx` (mirrors repo `README.md`) |
| `/marketplace` | Same-origin `GET /marketplace/v1/marketplace.json` — official first-party plugin pointers (`schemaVersion: 1`). Generated from repo `plugins/*/package.json`. |
| `/marketplace/v1/marketplace.json` | Public catalog for `zcc marketplace add` (CORS `*`). Alias: `/plugins/index.json`. |
| `/docs/*` | Rendered at build time from allowlisted `docs/*.md` via `scripts/sync-docs.mjs` (internal audits, architecture notes, and the root README are NOT published) |
| `/extensions` | In-app Plugin Guide `ProductMap` synced from `plugins/plugin-guide/` via `scripts/sync-plugin-guide.mjs` |
| `/extensions/sdk` | SDK overview — four layers and a link to the Plugin Guide map |
| `/download` | Parses `latest-mac.yml` from `NEXT_PUBLIC_UPDATE_FEED_URL`; links to GitHub Releases |

## Configure

Copy `.env.example` → `.env.local` and fill in the feed URLs once the CDN base
exists. All endpoints are env-driven so the same build points at any
environment without code changes — the same posture as the app.

## Deploy

The Dockerfile builds Next standalone **and** runs the pairing front door
(`node relay/front-door.mjs`). Next listens on container loopback; the front
door binds `0.0.0.0:$PORT`. Pairing paths (`/install.sh`, enroll, host ws) are
relayed only while a laptop is connected to `/_zcc/relay`. Set `ZCC_RELAY_TOKEN`
in the platform config (never in the image). Official desktop releases inline
the same origin (`ZCC_APP_URL`) and token at `electron-vite build` time — set
GitHub secrets `ZCC_APP_URL` and `ZCC_RELAY_TOKEN` (never commit them). Local
`pnpm run release:mac` still reads those env vars but does not publish.

`NEXT_PUBLIC_*` values are inlined at **build time**, so pass feed URLs as Docker
build arguments rather than runtime environment variables. Set `PUBLIC_BASE_URL`
in production so canonical URLs, `robots.txt`, and the sitemap use the real HTTPS
origin.

Build and run locally:

```bash
cd website
docker build --build-arg PUBLIC_BASE_URL=http://localhost:4321 -t zcc-web .
docker run --rm -p 4321:4321 -e PORT=4321 -e ZCC_RELAY_TOKEN=dev \
  -e PUBLIC_BASE_URL=https://zcc-7808c5bc8f3d.herokuapp.com zcc-web
curl -sI http://127.0.0.1:4321/ | head -n1          # Next
curl -sI http://127.0.0.1:4321/install.sh | head -n1 # 503 until a laptop is connected, not 308
```

To publish to Heroku app `zcc`:

```bash
cd website
heroku container:login
# Preserve the existing PUBLIC_BASE_URL and ZCC_RELAY_TOKEN runtime values.
# Docker 29+ defaults to OCI media types that Heroku's registry rejects
# (`error from registry: unsupported`). Force Docker schema 2 + gzip:
docker buildx build --platform linux/amd64 --provenance=false --sbom=false \
  --build-arg PUBLIC_BASE_URL=https://zana-ide.com \
  --output 'type=image,name=registry.heroku.com/zcc/web:latest,push=true,oci-mediatypes=false,compression=gzip,force-compression=true' .
heroku container:release web -a zcc
```

`heroku.yml` lives under `website/` — push from that directory. The `web`
process must stay `node relay/front-door.mjs`, not `node server.js`. The live
Heroku hostname is `https://zcc-7808c5bc8f3d.herokuapp.com` (not
`zcc.herokuapp.com`); the website's canonical origin remains `https://zana-ide.com`.

### Mobile relay in this Docker app

The same image can serve the website, the existing host pairing relay, and the
phone relay. In Heroku app `zcc`, set these **runtime** Config Vars:

- `MOBILE_RELAY_PUBLIC_URL=https://zcc-7808c5bc8f3d.herokuapp.com`
- `MOBILE_RELAY_TOKEN`: a new 43–128-character URL-safe secret (for example,
  generate it with `openssl rand -hex 32`). Keep it out of commands/logs and
  enter it through the Config Vars UI or a secret-safe API client.

Keep `ZCC_RELAY_TOKEN` unchanged; it authenticates a separate host-enrollment
service. No mobile configuration means the current website behavior continues.
Enter the same mobile URL and secret in desktop **Settings → Phone → Heroku
relay**, enable phone access, then scan a fresh pairing QR.

Ordinary visitors still see Next.js. `/_mobile/*`, `/_relay/*`, `/api/v1/*`,
`/ws`, and requests carrying the exact `zcc_mobile_session` cookie route to
the mobile gateway. A cookie selects a route but never grants authorization:
the desktop gateway validates it. Its route confinement still blocks internal
host and MCP endpoints. The mobile relay enforces HTTPS via Heroku's forwarded
protocol and the configured Host/Origin, independent of Next middleware.

The shared website origin is part of the trusted relay service. A separately
configured HTTPS hostname pointing at this same app can isolate website and
phone cookies if desired. The relay operator sees decrypted traffic. One
computer, **one always-on web dyno**, no Preboot/horizontal scaling; the desktop
must stay awake. Dyno restarts reconnect without replaying interrupted actions.

Canonical runtime files live in `services/mobile-relay`. Run
`node website/scripts/sync-mobile-relay.mjs` after editing them. The checked-in
snapshot under `website/relay/mobile` permits the existing website-only Docker
build context; a drift test verifies identical source. Next's tracing does not
include the front door, so the Dockerfile explicitly includes its `ws` runtime.

Container-backed regression from the repository root (isolated test app and
containers, no installed desktop restart):

```sh
docker build --platform linux/amd64 -t zana-mobile-website-test website
ZCC_MOBILE_DOCKER_IMAGE=zana-mobile-website-test pnpm test:e2e -- e2e/phone-network-connections.spec.ts
```

This checks the real Docker website alongside phone pairing, assets, session
revocation and reconnect. The Tailscale portion checks the Serve gateway
contract; a real tailnet/phone-network test additionally requires sign-in.

For an actual deployed relay, supply `ZCC_LIVE_MOBILE_RELAY_URL` and
`ZCC_LIVE_MOBILE_RELAY_TOKEN` through a private environment, then run
`pnpm test:e2e -- e2e/phone-heroku-relay.live.spec.ts`. The test refuses to use
an occupied relay and seeds only a private test desktop; it verifies pairing,
renderer assets, live events, heartbeats across a 65-second idle period and
revocation. Traces are disabled so credentials are not recorded. Setting
`ZCC_LIVE_HEROKU_RESTART_APP=zcc` additionally opts into restarting the existing
web dyno and verifying reconnection with the same phone session; this briefly
interrupts the website too. No dynos are created or resized by the test.

## Adding a doc

Edit the `DOCS` allowlist in `scripts/sync-docs.mjs`, then run
`npm run sync-docs` (also a `predev` / `prebuild` hook). Only listed files are
published; this is deliberate so internal `docs/*` (audits, plans, reviews)
stay private. `lib/docs.ts` reads the generated `content/docs/_manifest.json`.

## Plugin Guide map

The in-app Plugin Guide (`plugins/plugin-guide/src`) is the source of truth.
`scripts/sync-plugin-guide.mjs` copies `ProductMap` sources and `plugin-guide.css`
into `lib/plugin-guide/` for `/extensions`. Edit the plugin sources, then
run `npm run sync-plugin-guide` (also a `predev` / `prebuild` hook). Do not
hand-edit `lib/plugin-guide/`. The copy drops `.js` from relative imports so
Next can resolve the TypeScript files. `plugins/plugin-guide/src/api-sync.test.ts`
fails if the synced files or `docs/extensions-sdk-reference.md` drift.

## Official plugin marketplace

`scripts/generate-marketplace.mjs` writes `content/marketplace/marketplace.json`
from the repo `plugins/` tree (git pointers with `subdir: plugins/<id>`). The
site serves it at `/marketplace/v1/marketplace.json`. Desktop apps seed that
HTTPS URL automatically (override with `ZCC_OFFICIAL_MARKETPLACE_URL`; `off`
skips the seed). The seed is fail-soft if the feed is unreachable.
