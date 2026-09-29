# Zana Mobile

Expo 57 / React Native shell for the Zana web application, based on BB's current mobile architecture. Native routes own account sign-in and device settings; threads and plugins run in the server's WebView. See [the architecture, setup and release guide](../../docs/mobile-app.md).

```sh
pnpm mobile:ios        # from repository root; Xcode + CocoaPods required
```

Connect the running desktop in **Settings → Remote access**, then use **Continue with GitHub** on the phone or simulator, approve it and select the computer. Product traffic uses Zana Connect over HTTPS through Heroku.

- `app/`: Expo Router routes, including validated inbound deep links.
- `src/lib/`: platform-independent profiles, authentication, links and bridge policy, covered by Vitest.
- `src/state.tsx`: serialized SecureStore persistence.
- `src/session.tsx`: one session and cookie owner above the router. Screens retained by deep links must never mint their own competing sessions.
- `src/notifications.tsx`: validated notification taps; Connect push registration is not yet available.
- `e2e/flows/`: native Maestro flows.
- `eas.json`: development, preview and production build profiles. No signing accounts are embedded.
- `app.config.ts`: optional EAS identity and Android Firebase client config from the build environment; see `.env.example`.

Keep credentials native. Do not add Node/Electron imports to this package. Keep phone UI in the existing renderer when it represents product state; native screens own device capabilities only.

URL validation imports Expo's `whatwg-url-minimum` parser explicitly. React Native's fallback global URL behaves differently for custom schemes and path normalization; do not replace it based only on Node tests. Run the native acceptance flow after changing sign-in, cookies or deep links (see the guide).

The pinned `@react-native-cookies/cookies@6.2.1` dependency has an Android-only pnpm patch in the repository's `patches/` directory: Maven Central replaces the removed Gradle `jcenter()` API, and the library namespace moves from its manifest to Gradle. Keep this patch until migrating to a maintained cookie library; its upstream is archived. Re-run both platforms' session acceptance when replacing it. A fresh Android build in `mobile-android.yml` guards native compatibility separately from bundle export. If an existing Android build still resolves the old pnpm path after applying the patch, remove only `android/build/generated/autolinking/autolinking.json` and rebuild to regenerate that cache.

Keep the WebView Back handler scoped to screen focus, so it cannot swallow Back on native settings. Both platforms need the shell’s height-based `KeyboardAvoidingView`; visual viewport handling inside the page alone does not keep the composer above the keyboard. iOS also disables root WebView scrolling and the keyboard accessory bar: the renderer owns inner scroll areas, and WKWebView must not pan the entire document out of view when the keyboard resizes it. Android exposes clipped WebView text as zero-height accessibility nodes; bound conversation selectors below the web header and above the composer when testing visibility. The native acceptance flow sends with the software keyboard visible and then scrolls a conversation longer than the viewport in both directions before checking settings and Android Back.

Legacy profiles remain readable in SecureStore but cannot create a session or mount a WebView. Every native session requires a validated Connect account profile and HTTPS generated gateway origin. Old QR deep links open account sign-in without retaining or redeeming their payload. There is no camera/manual form, direct mode or LAN connection. Regression tests cover the no-network migration boundary and session cleanup when a profile becomes invalid.

The phone composer is renderer-owned: `ThreadComposerToolbar` and `mobile-shell.css` keep model/Send/Stop visible and disclose the other controls without remounting them. Returning focus to the editor closes the options so the software keyboard cannot leave them crowding the conversation. Do not swap editor instances on viewport changes; that would discard drafts. The mobile E2E checks 320px/390px geometry, draft retention, disclosure/Escape, touch-sized model rows, and the desktop transition. Keep the sponsor banner out of mobile composer views consistently; hiding it only while the editor has focus moves controls during a tap.

The timeline observes its own viewport as well as row sizes while following the latest message. Keyboard/options resize must not strand it above the reply. A successful local send resumes following, including queued sends that have no optimistic row; failed-send cleanup and another thread’s events must preserve scrollback. `ThreadTimeline.scroll.test.tsx` covers these boundaries; native acceptance verifies the reply is actually inside the visible conversation area after Send.


## Online sign-in

Normal onboarding is **Continue with GitHub** → approve this phone on
`https://zana-ide.com/connect/` → return to Zana Mobile → choose your computer.
Connect the desktop to the same account in **Settings → Remote access** first.
The computer list shows its named `xxx.zana-ide.com` address and online status.
Keep the computer awake and Zana running. Any internet connection works; local
network permission and shared Wi-Fi are unnecessary.

The browser receives only an approval code. A separate native polling secret
retrieves the revocable account credential over HTTPS. Pending sign-ins and
account credentials live in SecureStore so returning from Safari survives a
process restart. The app authenticates to validated, generated Connect gateway
hosts; friendly domains are display addresses. No credential is placed in a
deep link. Existing profiles stay intact for identification/removal; retired
profiles never reconnect. Simulators use the same online account flow.

Backend deployment must include `website/connect/phone-login.mjs`, its HTTP
routes, the phone approval page, and the OAuth return allowlist before shipping
a mobile build with this onboarding. The existing `connect_codes` and
`connect_devices` tables support it without a schema migration.

## App icon

The mobile icon keeps Zana's fairy, blue/lavender wings and golden spark. Its
editable master is `assets/icon.svg`, adapted from `../../resources/icon.svg`
with an edge-to-edge navy background. Keep the mobile PNG square, 1024 × 1024
and opaque; iOS supplies the corner mask. Do not copy the desktop PNG here:
its transparent Dock margins make the phone icon appear inset.

Regenerate the checked-in PNG from the repository root with the website's
installed Sharp dependency:

```sh
node --input-type=module <<'JS'
import { createRequire } from 'node:module';
const sharp = createRequire(`${process.cwd()}/website/package.json`)('sharp');
await sharp('apps/mobile/assets/icon.svg').resize(1024, 1024)
  .flatten({ background: '#15233f' }).png()
  .toFile('apps/mobile/assets/icon.png');
JS
```

The icon is a native asset: an installed app receives it through a new signed
build and TestFlight update. A JavaScript reload cannot update the Home Screen
icon. Inspect the icon embedded in that IPA as well as the source PNG.

## TestFlight releases

The welcome screen includes **Try a demo without connecting**. It opens an offline sample conversation, labels every reply as scripted, and neither creates a server profile nor starts an agent. This gives new users and beta reviewers a way to explore before pairing; it is not a substitute for testing the connected app. Review notes and remaining publisher metadata are in [the beta review draft](../../docs/mobile-beta-review-notes.md).

Normal iPhone onboarding is **Settings → Phone** in the desktop: install TestFlight from the iPhone App Store → accept Zana’s invitation and install → open Zana → computer GitHub connection → GitHub sign-in and phone approval → choose computer → live verification. The invitation is unavailable until a release owner configures an approved Zana beta group. The first step also includes **Install with a USB cable (iPhone or Android)** with numbered development-install instructions and an optional AI helper; Android continues to use that path.

The manual `Mobile iOS TestFlight` workflow uses EAS CLI 24.8.0, Zana’s own project/signing identities, and a fresh native prebuild. It inspects the signed IPA’s bundle identifier, version, build, standalone JavaScript and store provisioning before any optional submission. Submission defaults off. See [release configuration, approval and reviewer requirements](../../docs/mobile-testflight-release.md). BB’s beta-group distribution helper is adapted with its MIT notice retained in `scripts/testflight-distribute.mjs`.

Regression finding (2026-09-28): a local generated iOS tree still had **0.1.0 / build 1** although `app.json` declared **2.3.0 / 202609281455**. Do not trust Expo config alone or install that stale artifact. The correct previously verified 2.3.0 device IPA was development-signed; it must not be submitted to TestFlight. `scripts/verify-ipa.py` intentionally rejects development/ad-hoc profiles.
