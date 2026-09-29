# Zana TestFlight releases

Zana follows BB’s EAS → TestFlight processing → optional beta-group distribution approach using its own accounts. This repository prepares the pipeline; it does not claim a published app, invite testers automatically, or publish to the App Store. The workflow has **only `workflow_dispatch`**, and `submit` defaults to **false**.

## One-time owner configuration

The approved publisher setup on 2026-09-28 is Expo [`@grebmann/zana-mobile`](https://expo.dev/accounts/grebmann/projects/zana-mobile), project `3b4e4124-5a4b-41a0-acf9-25ca4bab8fca`, and Apple team `S7RVD35N33`. App Store Connect app [`Zana-ide`](https://appstoreconnect.apple.com/apps/6817069720/testflight) has ID `6817069720`; Apple reported the shorter catalogue name “Zana” was already taken. The installed app name remains Zana and its bundle identifier remains `ai.zana.mobile`.

These public identifiers are configured in the protected `mobile-ios-release` GitHub environment. Production signing is configured in EAS, and an App Manager API key is assigned for EAS Submit. Its private key is also stored as `ASC_API_KEY_P8` in the protected GitHub environment. `MOBILE_RELEASE_ENABLED` remains `false`: the CI Expo token and published workflow still need activation, and beta availability must be verified separately. Creating the app record does not create a TestFlight invitation.

The first EAS store build is [2.3.0, build 2](https://expo.dev/accounts/grebmann/projects/zana-mobile/builds/bc977c15-87af-49fe-9d3d-4b6d115849e6). Its signed native metadata, bundled JavaScript, App Store provisioning and signing certificate passed local verification. SHA-256: `2f5f134c4f40ba41deaf46d21e01c193ada11f320f8fe5cbde302ac483549f5c`. The artifact is retained locally in `dist/mobile/testflight-2.3.0-2/`; it is separate from the previously installed development IPA. The [EAS submission](https://expo.dev/accounts/grebmann/projects/zana-mobile/submissions/c3bdd010-2c07-4747-9c30-89e88435610c) remained queued and was explicitly canceled, with cancellation verified before any retry. Xcode's `altool` then validated and uploaded the exact same IPA with no errors. Apple delivery/build ID `44c62eba-f183-447b-b901-8b2249afd955` finished processing as **VALID**. No App Store publication was requested.

The beta description, demo review notes and build-specific “What to Test” instructions are saved in App Store Connect. Build 2 is attached to the `Release testing` internal group. The release owner was enrolled through App Store Connect's internal tester picker; the UI confirms one internal tester with status **Invited**, and the API independently reports `IN_BETA_TESTING`. The earlier API enrollment attempt used a different existing beta-tester record and returned “Tester(s) cannot be assigned.” The picker created the correct internal membership without changing account roles or deleting a tester. The `Zana beta` external group exists with its public link disabled. Feedback email, review contact details and a published privacy policy remain required before external review. A valid processed build and invitation do not establish a successful TestFlight installation or phone connection.

The icon refresh is now **2.3.0 (3)**, [EAS build 62b13604-0007-45c9-8c0c-e37d30593926](https://expo.dev/accounts/grebmann/projects/zana-mobile/builds/62b13604-0007-45c9-8c0c-e37d30593926). It preserves the familiar fairy artwork while removing the desktop icon's white/inset margin on iPhone. The 1024px source PNG is opaque, and the actual embedded native icon was extracted and compared to that artwork. Native metadata, bundled JavaScript, App Store provisioning and signature passed verification. SHA-256: `e88a466cfad722b0baf50f94503145078d5ea259fe04d05d26a2ca20223f3aad`. Apple delivery/build `2a3095da-13f7-4d7b-9ce0-fe597fad60ef` passed validation and processing and is `IN_BETA_TESTING` in the existing `Release testing` internal group; evidence is retained in `dist/mobile/testflight-2.3.0-3/`. Its runtime source comes from the build 2 snapshot with only the icon changed. The earlier build 2 and development IPA remain intact.

Physical TestFlight acceptance is pending on the owner's iPhone: open Apple's invitation, accept it in TestFlight, and install **Zana-ide 2.3.0 (3)** over the existing app without uninstalling. The Mac's iPhone Mirroring currently requires iCloud sign-in. Wireless device inspection has been unreliable, although TestFlight was successfully launched on the exact target iPhone after build 3 became available. Complete Install/Update in TestFlight; if wireless inspection remains unavailable, connect the unlocked target iPhone by USB to verify its actual native version/build and launch. The installed desktop was previously configured for local-network pairing, but that flow is now retired in source. Build 3 does not include the new GitHub onboarding. Online acceptance requires deploying the phone sign-in service and shipping a new desktop/mobile build, then connecting both through the same GitHub account. Do not regenerate local pairing QR codes for the new flow or restart the desktop while agents are running without approval.

Use the intended Zana publisher’s paid Apple Developer team, App Store Connect application (`ai.zana.mobile`) and Expo project. Initialize EAS credentials interactively in the provider’s own UI/CLI, using the existing signing account. Never put credentials in chat or commit them. Confirm the EAS remote iOS build number is suitable and monotonically increasing for this application before its first CI build.

Create GitHub environment **`mobile-ios-release`**, restrict allowed release branches and require a release-owner reviewer. Configure:

| Environment variable | Meaning |
| --- | --- |
| `MOBILE_RELEASE_ENABLED` | Set to `true` only after configuration/review is complete |
| `EXPO_PUBLIC_EAS_PROJECT_ID` | Zana’s EAS project UUID |
| `EXPO_OWNER` | Zana’s Expo account/organization |
| `APPLE_TEAM_ID` | Intended Apple signing team |
| `ASC_APP_ID` | Numeric App Store Connect app ID |
| `ASC_API_KEY_ID` | App Store Connect API key identifier |
| `ASC_API_KEY_ISSUER_ID` | Key issuer UUID |

Environment secrets: **`EXPO_TOKEN`** and (for submission) **`ASC_API_KEY_P8`**. Install signing credentials in EAS ahead of time; CI uses `--freeze-credentials` and never repairs/creates signing identities. The API key is written with mode `0600` to the runner’s temporary directory only after the build archive is uploaded, and removed on every workflow exit. The generated submit profile exists only in the disposable workflow checkout. Never run `release-config.mjs prepare` in a working checkout you want to preserve.

## Build and submit

1. Review the committed Expo marketing version in `apps/mobile/app.json`. Dispatch **Mobile iOS TestFlight** with `submit=false` to prepare a build. This spends EAS build capacity and uploads source; workflow dispatch is a deliberate owner action, not a desktop setup operation.
2. CI requires an absent generated `ios/` tree. EAS generates a fresh native project. Remote EAS versioning increments the build number. This prevents the observed stale local Info.plist from entering CI.
3. CI selects exactly one finished production/store/iOS build for the configured EAS project, downloads its artifact, and verifies the real signed application: bundle/version/build, Apple team, non-expired App Store profile, non-debug entitlements, deep strict code signature, signing certificate authorized by that profile, and bundled JavaScript. It uploads a small SHA-256/metadata verification record.
4. For a release approved for upload, dispatch with `submit=true`. The workflow builds and verifies that run’s artifact, then submits **that local IPA path**. It never uses `--latest` or uploads before verification. EAS submission processing is awaited. This makes the build available for TestFlight processing; it does not publish an App Store release.
5. Optionally set `external_group` to an existing uniquely named group. The helper waits up to 45 minutes for the exact version/build to finish Apple processing, rejects failed/expired/ambiguous results, submits Beta App Review when needed, and attaches the build idempotently. Review approval and group attachment are different states; the script does not claim external availability before Apple approves it. Internal groups do not request external review.

A failed upload must be investigated before another dispatch: each dispatch creates a new build. For a retry of an existing verified artifact, use an explicit EAS build ID or verified local IPA with the same submit profile, never `--latest`. Keep the SHA-256 record with the release.

## Beta review and invitation activation

The owner selected a **shared public TestFlight invitation** for normal onboarding. Apple enrolls users who open the link; Zana does not collect an invitation email list or grant users App Store Connect roles. Use the existing **Zana beta** external group (`cea0a86f-4116-47f1-a394-caea0e7df9a0`) with an initial **1,000-tester limit**. Subsequent approved builds go into this same group, preserving the invitation and membership. This installation link grants no access to anyone's desktop; desktop pairing is separate.

The **Mobile TestFlight invitation** workflow (`mobile-testflight-invitation.yml`) manages an existing verified build without rebuilding or needing Expo credentials. It uses the protected `mobile-ios-release` environment and its Apple API secret; set `ASC_BETA_GROUP_ID` to the external group above. The workflow still needs to be published to the approved branch before it can run in GitHub. Its independent beta-invitation action does not enable the disabled EAS build workflow.

- **check** performs read-only validation of the exact app/bundle, iOS version/build, external-group ownership, processing/expiration, review metadata and invitation state. Its JSON lists missing field names without contact or credential values.
- **publish** first performs the same validation. With missing metadata it makes no changes. It requests beta review only for a build ready for submission, enables tester notifications, and attaches the exact build to the group. While review is pending it returns `waiting-for-apple` and keeps the invitation disabled. Re-run after Apple's decision; rejected, expired and unknown states cannot enable the link.
- Once Apple permits external testing, **publish** enables the public link with the selected cap, re-reads the group and build, and emits `available` with the actual Apple join URL only after verifying both. Re-running is idempotent. The status artifact is suitable for the desktop release's invitation configuration; activation does not silently rewrite source or restart a desktop.

The same command works locally with an Apple API key file (never paste its contents into chat). For this verified release, with `ASC_APP_ID`, `ASC_API_KEY_ID`, `ASC_API_KEY_ISSUER_ID` and `ASC_API_KEY_PATH` supplied securely:

```sh
node apps/mobile/scripts/testflight-public-link.mjs \
  --action check \
  --group-id cea0a86f-4116-47f1-a394-caea0e7df9a0 \
  --build-id 2a3095da-13f7-4d7b-9ce0-fe597fad60ef \
  --version 2.3.0 --build 3 --limit 1000
```

Use `--action publish` for the authorized beta review/activation operation. Neither action uploads an IPA, creates individual tester invitations, publishes an App Store release, or changes desktop network access. The owner still must provide the real feedback/review contact details and a published privacy-policy URL; the automation cannot invent them. A syntactically valid privacy URL must also be verified by the publisher as reachable and accurate.

Before requesting external review, fill in TestFlight test information, privacy/support details, and review notes in App Store Connect. Provide an isolated reviewer environment with sample projects and a dedicated reviewer account, or a reviewed native demo experience. A reviewer must not depend on the release owner’s laptop, agents, credentials or an expiring one-time pairing QR. Provisioning that environment and publishing the invitation require release-owner action; no live reviewer environment or public invitation is created by this change.

The mobile app now includes **Try a demo without connecting** on Add server. This opens a local sample conversation with explicitly scripted replies, no server profile, and no requests or agent execution. The demo is intentionally limited; it does not prove the connected desktop features. [Draft beta description, test instructions and reviewer notes](mobile-beta-review-notes.md) disclose that limitation. Rehearse them on the exact signed release; Apple may still require access to the connected features. The isolated-simulator Maestro flow is `apps/mobile/e2e/flows/demo.yaml` (it clears test state, so never run it against a user's installed app).

Native distribution is currently deferred: Settings → Mobile shows **Coming soon** and directs users to their personal domain in a mobile browser. The invitation controls must be restored deliberately when native onboarding resumes.

After approval, enable the beta group’s public invitation and verify that a fresh invited iPhone can install and open Zana. Set `RELEASE_TESTFLIGHT_URL` in `apps/server/src/mobile/distribution.ts` to the actual `https://testflight.apple.com/join/XXXXXXXX` invitation when preparing the desktop release. Operators can override it with `ZANA_MOBILE_TESTFLIGHT_URL`; only exact Apple join URLs are accepted. Do not substitute an App Store URL or a desktop pairing URL. TestFlight invitation QR codes contain no desktop credentials.

TestFlight builds expire after 90 days. Release owners must keep an approved build available, maintain the group’s invitation, and disable the shipped invitation in a later desktop release if beta distribution is withdrawn. For current onboarding, users should follow the mobile browser setup in Settings → Mobile.

## Regression and verification

On 2026-09-28 the local generated Xcode project emitted **0.1.0 / build 1**, despite Expo config declaring **2.3.0 / 202609281455**. The installation was rejected. The correct existing device IPA (SHA-256 `ba5594afd692c9729d049121e322d4f7ebd0dd9c7c812bcbd49d2af1658779be`) was later installed and its version/build independently verified. It is development-signed and is not a TestFlight candidate. Do not rewrite this finding as a successful initial build or use the Expo version as installed-version evidence.

The new live check also exposed a desktop gateway routing bug: its upstream URL was resolved at module initialization, before the runtime selected its actual listening port. With multiple desktop instances, a phone could reach the instance on the default port. The gateway now resolves the URL when starting, and the Electron test compares phone-visible projects against that specific isolated desktop before allowing setup to pass.

Verification of the first real store IPA exposed a verifier argument bug: macOS `codesign` requires the optional certificate prefix as `--extract-certificates=<prefix>`. Passing the prefix as a separate argument made it interpret the prefix as an application path. The verifier and its regression mock were corrected, then all four verifier tests and the full check against the signed IPA passed. No app rebuild was needed for this verification-tool correction.

Local checks (no provider accounts, builds or submissions):

```sh
pnpm exec vitest run apps/mobile/scripts apps/server/src/mobile apps/app/src/views/settings/PhoneSettingsView.test.tsx apps/app/src/lib/mobile-readiness.test.ts
python3 -m unittest discover -s apps/mobile/scripts -p 'test_verify_ipa.py'
pnpm test:e2e -- e2e/phone-settings-pairing.spec.ts e2e/phone-connect-account.spec.ts e2e/phone-network-connections.spec.ts
```

The Electron acceptance tests use private app homes and simulated authenticated phone sessions. They do not install on a physical phone or prove App Store Connect acceptance. The LAN test mounts the actual built renderer in a mobile browser with the native bridge; the Connect test checks readiness across the authenticated account tunnel. Manual release acceptance must still install through TestFlight on a physical iPhone and load the intended desktop’s projects.

References: [Expo TestFlight](https://docs.expo.dev/submit/testflight/), [EAS CLI](https://docs.expo.dev/eas/cli/), [Apple external testers](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers/), [BB distribution helper](https://github.com/get-bb/bb/blob/main/apps/mobile/scripts/testflight-distribute.mjs).
