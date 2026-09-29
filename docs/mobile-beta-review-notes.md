# Zana 2.3.0 — TestFlight review preparation

Prepared for `ai.zana.mobile`. This is a submission draft, not a record of Apple approval or a published beta. Complete publisher/contact information and rehearse these steps against the exact store-signed IPA before submitting.

## Beta description

Zana is a mobile companion for Zana running on your computer. Pair your phone to follow your coding agents, view projects and conversations, send requests, and respond when your agents need input. Your computer runs the work. The phone connects through Zana Connect over the internet.

## What to test

- Open the app and try the sample conversation without a server.
- For the next build with online sign-in: connect desktop in Settings → Remote access, continue with GitHub on the phone, approve the phone, and choose the computer. Existing uploaded builds retain their QR flow.
- Check that the expected projects and conversations appear.
- Send a request, switch away from the app, and return to the conversation.
- Try reconnecting after changing networks, and confirm an unavailable computer produces a recoverable error.

## Review notes

Zana is a client for a server the user runs on their own computer. It does not provide a hosted coding agent account. A real connection requires a running Zana desktop connected to the same GitHub account, explicit phone approval and an internet connection. Previously uploaded builds used QR pairing; the next build removes it along with direct/local Wi-Fi connections.

The app includes an explicitly labeled local demo so you can explore a sample conversation without an account, laptop, pairing code, network connection, or camera permission. The demo uses sample data and scripted replies. It does not access files, execute code, or contact an AI service. It is a limited demonstration, not a real coding session, and does not demonstrate all connected desktop features.

1. Launch Zana. The initial account sign-in screen is headed **Your agents, anywhere.**
2. Scroll down and tap **Try a demo without connecting**.
3. Read the sample project and conversation on **Explore Zana**.
4. Enter a message in **Try a sample message**, then tap **Send sample message**. The reply is explicitly labeled as a demo.
5. Tap **Reset demo** to clear the sample exchange.
6. Tap **Connect my computer** to return to the online sign-in screen.

For full connected-feature review, provide a separately approved reviewer environment and current access instructions if Apple requires it. Do not supply a developer's desktop, personal project data, or a short-lived pairing code that will expire before review. Acceptance of the demo is Apple's decision.

## Publisher setup

- Approved Expo owner/project: `grebmann/zana-mobile`, EAS UUID `3b4e4124-5a4b-41a0-acf9-25ca4bab8fca`.
- Approved Apple Developer team: `S7RVD35N33`.
- App Store Connect record: `Zana-ide`, numeric app ID `6817069720`, intended bundle identifier `ai.zana.mobile`.

## Publisher information still required

- Beta feedback email and reviewer contact name, email, and phone (enter private contact details directly in App Store Connect).
- Published privacy policy URL and support URL, reviewed by the publisher.
- Physical-device acceptance result for the verified store build.

## Confirmed distribution choices

- Store build **2.3.0 (2)**, Apple build ID `44c62eba-f183-447b-b901-8b2249afd955`, passed signed-IPA verification and Apple processing. SHA-256: `2f5f134c4f40ba41deaf46d21e01c193ada11f320f8fe5cbde302ac483549f5c`.
- **Release testing** is the internal group; the owner is invited.
- **Zana beta** is the external group. The owner approved a shared public invitation after external beta approval, with an initial limit of 1,000 testers. The link is still disabled while review metadata is incomplete.
- Desktop Settings already supports the eventual Apple invitation link and QR. Phone-to-desktop pairing remains a separate authenticated step.

No private contact information or signing credentials belong in this document.
