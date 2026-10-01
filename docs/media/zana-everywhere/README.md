# Use Zana everywhere

`zana-everywhere.mp4` is the shareable 64-second video: 1920 × 1080, 24 fps,
H.264/yuv420p with AAC audio and fast-start playback.

The walkthrough follows the approved `script.md`:

1. Click the bottom-left **Remote access** icon, then **Get a connect code**.
2. Sign in with GitHub, enter **my-domain**, reserve the address, and copy the code.
3. Paste the code into desktop Zana; the computer connects automatically.
4. Open **my-domain.zana-ide.com** in Safari on iPhone.
5. Sign in with the same GitHub account and tap **Open Zana**.
6. Follow agents in the responsive kanban, with Safari controls visible.

Keep the computer awake and online, with Zana running and Remote access enabled.

This is an illustrated browser walkthrough. The address and connect code are
examples. No account, address, or device was registered to produce it. The ending
uses the existing `MobileAgentBoard` component capture and product styles with
sample agents, framed in illustrated Safari chrome. It does not show a native
mobile app or installation flow.

Voice: **Microsoft Ava Multilingual Neural**, `en-US-AvaMultilingualNeural`, at
`-5%`. “my-domain” is spoken as “my domain”. All seven segments retain their
original speech pace, with no time stretching; the assembled track is normalized
to -16 LUFS with a -1.5 dBTP target.

## Files

- `zana-everywhere.mp4`: finished video.
- `index.html`: local player with optional English captions.
- `zana-everywhere.en.srt` / `.vtt`: caption files.
- `script.md` / `narration.txt`: storyboard and narration.
- `voiceover.wav`: finished narration track.
- `poster.jpg` / `contact-sheet.jpg`: thumbnail and storyboard review.
- `preview-*.jpg`: full-size key frames.
- `audio-neural/`: cached speech and timing metadata.
- `render.py`: editable source, using the visual helper functions from
  `../mobile-connect/render.py` and the existing `../mobile-connect/mobile-kanban.png`.

## Render

Requires Python, Pillow, edge-tts, ffmpeg, and ffprobe. Initial speech synthesis
needs internet access; subsequent renders reuse the cached clips.

```sh
python3 render.py --stills
python3 render.py --audio-only
python3 render.py
```

The approved earlier native-app video is preserved in `../mobile-connect/`.
