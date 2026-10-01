# Zana Mobile connection walkthrough

84-second, 1920 × 1080, 24 fps MP4 with English neural voiceover (Microsoft Ava Multilingual),
on-screen instructions, and a complete subtitle transcript.
Illustrated screens use the current product's button labels and sample project data.
The on-screen address **grebmann.zana-ide.com** and connect code are examples.
The narration asks viewers to choose their own subdomain.
The video starts with Zana installed on the computer. Phone installation is shown after the computer connects to the chosen subdomain.

1. On the computer: **Settings → Remote access → Get a connect code**.
2. In the browser, sign in with GitHub and choose your subdomain. Select **Reserve address and get code**. Copy the code.
3. Paste the code into desktop Zana. The computer connects automatically.
4. On the connected computer, open **Settings → Phone**. Scan the install QR with the iPhone Camera, accept the TestFlight invitation, and install Zana. Then open the app. If TestFlight is missing, install it first and reopen the invitation.
5. In Zana Mobile, tap **Continue with GitHub**, using the same account.
6. Tap **Approve phone** in the browser, then return to Zana Mobile.
7. Choose the computer and tap its **Connect** button.
8. The ending stays on the mobile kanban, captured from the actual MobileAgentBoard component and product styles with sample agents.

The QR scene directs viewers to the installation QR in their desktop app. Without an `install-qr.png` asset, it uses an explicitly labeled, non-encoded QR illustration. Supply a verified public TestFlight invitation QR as `install-qr.png` to make the QR in the video scannable.

Keep Zana running on the computer and keep the computer awake and online.

`mobile-connect-with-install.mp4` is the shareable video; the other MP4 filenames are copies of the same current export. SRT and VTT files provide captions;
`poster.jpg` is a thumbnail. `render.py` is the editable source (Pillow + ffmpeg + edge-tts).
`voiceover.wav` is the finished narration track; `narration.txt` is the editable transcript.
Speech snippets are cached under `audio-neural/`. Rendering checks each line fits its scene,
then normalizes the assembled narration to -16 LUFS and encodes it as AAC.
Run `python3 render.py --stills` to review key frames, or `python3 render.py` to render.

Product references: `OnlineConnect.tsx`, `ConnectCodePairing.tsx`,
`ComputerCode.tsx`, `PhoneSignIn.tsx`, `PhoneSettingsView.tsx`, `MobileShellChrome.tsx`,
`MobileAgentBoard.tsx`, `mobile-shell.css`, and `docs/mobile-connect.md`.
The board capture uses `board-preview.tsx` with the product component and CSS.
Voice synthesis uses [edge-tts](https://github.com/rany2/edge-tts); cached MP3 clips make subsequent renders offline.
Install the rendering dependencies with `python3 -m pip install Pillow edge-tts`.
