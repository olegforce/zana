# Zana Mobile Relay on Heroku

A standalone Node service for **one computer per Heroku app, on exactly one web dyno**. It forwards HTTP and WebSockets to Zana's authenticated mobile gateway through an outbound desktop connection. The computer still runs all agents and owns pairing credentials. It must stay awake and online.

The relay terminates HTTPS and can see traffic. Use an app/account you trust. This is not end-to-end encryption. No prompts, cookies, tokens, request paths or bodies are logged by this service. Heroku's router still produces its normal access logs.

This is a legacy backend compatibility service. Current Zana Mobile uses GitHub
sign-in through [Zana Connect](../../docs/mobile-connect.md); desktop Phone
settings no longer offer manual relay URLs or QR pairing.

## Deploy

For the existing Zana website/Heroku app, use the integrated deployment in
[website/README.md](../../website/README.md#mobile-relay-in-this-docker-app).
It keeps the website and host pairing service on the same container. The
standalone deployment below remains available for a separate app.

This directory is independently deployable: it has its own package lock, Procfile and container. It needs no Zana checkout or build at runtime.

1. Create a Heroku app in the account/region you intend to use. Obtain its exact `https://…herokuapp.com` URL; modern Heroku app hostnames can include a suffix.
2. In its Settings → Config Vars, set `MOBILE_RELAY_PUBLIC_URL` to that origin (no path) and `MOBILE_RELAY_TOKEN` to a freshly generated secret. `openssl rand -hex 32` generates a suitable value. Keep the secret out of shell arguments, commits, URLs and screenshots.
3. Deploy this directory as the Git root with the Heroku Node.js buildpack, or use Heroku Container Registry from this directory:

```sh
heroku container:login
heroku container:push web --app YOUR_APP
heroku container:release web --app YOUR_APP
heroku ps:scale web=1 --app YOUR_APP
```

Select one **Basic or higher, always-on web dyno**. Do not enable horizontal scaling or Preboot: separate dynos do not share the desktop socket. Multi-computer hosting and a cross-dyno routing backplane are future work. Provisioning and running Heroku resources incurs the account's normal charges.

4. For backend compatibility testing, supply the same `MOBILE_RELAY_TOKEN` securely in the environment and run `pnpm mobile:serve --connection relay --public-url https://YOUR_APP.herokuapp.com` from the repository root with desktop running. The local gateway binds only to loopback.
5. Its pairing output supports older clients and transport tests. Current Zana Mobile must instead use the account service; do not use this utility as its installation or sign-in flow.

`GET /_relay/health` reports only service version and whether the computer is connected. Other requests require the desktop gateway's normal pairing/session authorization. `/_relay/connect` requires the tunnel secret and accepts only one desktop at a time. Rotate the secret in both Heroku and the gateway environment if compromised; revoke individual phones in desktop settings.

## Heroku behavior

- Bind to `0.0.0.0:$PORT`; Heroku terminates TLS. The relay requires the router's `X-Forwarded-Proto: https` and the configured Host. Plain HTTP requests are refused; use the HTTPS health URL too.
- 20-second WebSocket ping traffic stays below Heroku's 55-second idle window. Dead peers are disconnected.
- Reconnect the desktop with capped backoff after a dyno restart. Pairing remains on the computer, so restarting only the relay does not require re-pairing.
- Pending HTTP requests fail on disconnect and are **never automatically replayed**. Check whether the action completed before manually retrying a send.
- Bounded transfers: 64 concurrent streams, 32 MiB request bodies, 64 MiB responses, 1 MiB application WebSocket messages, and 4 MiB outbound buffer ceilings. Slow peers are disconnected rather than accumulating unbounded memory.
- The relay fails HTTP requests after 25 seconds without response traffic, before Heroku's initial response deadline. Long operations should acknowledge promptly and stream updates over the application's existing WebSocket.
- SIGTERM closes tunnels and active connections. Nothing is persisted to the dyno filesystem; no database is required for this single-computer version.

References: [HTTP routing](https://devcenter.heroku.com/articles/http-routing), [Dyno restarts](https://devcenter.heroku.com/articles/dyno-restarts), [Node deployment](https://devcenter.heroku.com/articles/getting-started-with-nodejs).

## Verification

From the Zana repository root, run `pnpm exec vitest run services/mobile-relay` for protocol and real HTTP/WebSocket gateway tests. The built-Electron phone connection regression lives in `e2e/phone-network-connections.spec.ts`. A local regression does not establish a live Heroku deployment or physical-phone internet access.
