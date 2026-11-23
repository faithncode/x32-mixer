# X32 Mixer

Desktop remote control for Behringer X32 / Midas M32 consoles, built for church sound teams: easy to use with only a mouse, with extra care for the live stream.

It talks to the console over the network with the X32's standard OSC protocol (UDP port 10023), the same way other X32 remote apps do. Nothing needs to be installed or changed on the console, and it can run at the same time as other remote apps.

## Features

**Mixing**
- Layers: channels 1–32, aux inputs, FX returns, buses, matrix, DCA, plus a ★ Custom layer, with Mono and Main LR always visible.
- Each strip has a fader, mute, solo, pan, meter with clip light, EQ curve preview, and Ø / low cut / gate / compressor buttons.
- Channel panel: input source, preamp gain and +48V (it follows the console's own channel-to-preamp table and asks before turning on phantom power), trim, EQ with a draggable curve, gate, compressor, bus sends, and DCA / mute group assignment.
- Copy / paste processing (EQ, gate, compressor, input) between strips of the same type, with confirmation.
- Mute groups, clear solo, FX rack, scenes (recall and save, always confirmed).

**Monitor mixes**
- Pick a bus and the faders become each input's send to it.
- Mix groups per bus: mix DCAs and mix mute groups that affect only that mix (stored in the app).

**Live stream**
- Stream bus meter: peak, 3-second level, clip count, and speech-vs-songs balance with advice.
- Clip guard (optional): lowers the stream bus fader up to 6 dB if the stream gets close to clipping, then eases it back.
- Optional limiter on the stream bus, using the X32's own bus compressor, with undo.
- Sermon mode (optional): keeps the pastor, translator and Bible readers at an even level on the stream bus only.
  - Holds during songs, detected from the band group's combined level against a line you set.
  - Compensates when two people talk at once, and never boosts past the fader's +10 dB.
  - Glides back to your levels when switched off.
- End of service (one click, confirmed): fades every input's send to the stream bus down while the playback channel(s) fade up, so the closing slides roll with music on the stream.
  - Only the stream bus changes: the room, wedges, channel faders and mutes stay as they are.
  - **Back to live** fades every send back to where it was. Any send moved by hand in between is left where you put it.
  - Playback channels, playback level and fade time are set in its Setup. A top-bar badge shows while the stream is on playback.

**Alerts:** clipping on the live stream and main mix (all channels optional), a live input going silent, and an input running unusually low.

**Mouse-friendly:**
- Right-click menus for presets (0 dB, −10, off, center pan, reset, rename, color).
- The wheel moves faders in 0.5 dB steps.
- Knobs and sliders only take the wheel after you click them.
- Screen size setting, and auto-reconnect to the last console.

**Safety:**
- Controls lock while disconnected.
- The app reads the console on connect and only writes what you change.
- Automatic features only touch the sends and fader they own, and your own moves always win.

## Download

Ready-to-install builds are made automatically on GitHub for every push to `main`:

1. Open the repo's **Actions** tab, then the latest **Build** run.
2. Under **Artifacts**, download `mac-dmg-apple-silicon`, `mac-dmg-intel` or `windows-exe`.
   - Mac: `X32-Mixer-…-mac-arm64.dmg` for Apple Silicon (M1 and later), `…-mac-x64.dmg` for Intel Macs.
   - Windows: `X32-Mixer-…-win-x64.exe` (installer).

To publish a numbered release with the files attached, push a tag: `git tag v0.2.0 && git push origin v0.2.0`.

The builds are not code-signed yet:
- **Mac:** the first time, right-click the app and choose **Open**, then **Open** again. If macOS still says it is damaged, run `xattr -cr "/Applications/X32 Mixer.app"`.
- **Windows:** on the SmartScreen warning, click **More info**, then **Run anyway**.

Build locally with `npm run dist:mac` or `npm run dist:win` (output in `dist/`).

## Run

```bash
npm install
npm start
```

Type the console's IP and click **Connect**, or click **Scan**. The computer must be on the same network as the console. On Windows, allow network access when asked.

## Without a console

```bash
npm run emulator      # fake X32 on udp/10023
npm start             # then connect to 127.0.0.1
npm test              # protocol, model and emulator tests
```

## Not yet verified on a real console

- Whether the stream bus meter reads after the bus fader. Clip guard needs it to.
- The channel-to-preamp mapping (`/-ha/NN/index`) and the input source list.
- Scene save argument format, and send-level step size.
- FX parameters are labelled P1–P16 (real names per effect type are not mapped yet).

## Layout

- `src/main/osc.js`: OSC codec and X32 meter decoding
- `src/main/x32client.js`: UDP session (keepalive, meter subscriptions, query queue with retries, reconnect/resync, discovery)
- `src/main/main.js`, `src/main/preload.js`: Electron main process and bridge
- `src/shared/x32.js`: X32 parameter paths, value types, unit conversions, meter layout
- `src/renderer/`: user interface
- `tools/x32-emulator.js`: fake console for development and tests
- `test/`: automated tests (`npm test`)
