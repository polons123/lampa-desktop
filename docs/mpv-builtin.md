# Built-in mpv player for Lampa on macOS (Apple Silicon)

Status: **works when run from source; not packaged.** All changes are uncommitted in
`~/lampa-desktop-src/repo`, a clone of `ARST113/lampa-desktop` (`main`, version ac3.21).

## Goal

A Lampa desktop client for an Apple Silicon Mac that plays video inside its own
window with mpv, so formats the web player cannot handle (AC3/EAC3/DTS audio,
HEVC, awkward containers) work, while keeping Lampa's own player controls.

IINA is a standalone app and cannot be embedded, so it only works as an external
player. The built-in player uses **libmpv**, the engine IINA is built on.

## What was done

### 1. External players on macOS

- mpv and IINA (via `iina-cli`) are detected by `src/modules/playerFinder.js`.
- `iina-cli` is on the launch whitelist (`src/modules/ipcHandlers/processHandlers.js`).
- The macOS-only hiding of the "find player" settings was removed (`src/plugin.js`).
- Automatic player selection at startup stays **off** on macOS
  (`src/modules/lampaInitializer.js`), so the app does not rewrite Lampa's player
  type.

### 2. Button to change the Lampac / Lampa address

- Settings → Application → «Изменить адрес Lampa…» (`src/plugin.js`).
- It opens the existing connection panel (`src/recovery.html`) in a new **edit
  mode** with a Cancel button. The main Lampa window stays open.
- Main process: `openAddressEditor()` in `src/modules/windowManager.js`; IPC
  `open-address-editor` (sender-validated) in `ipcHandlers/windowHandlers.js`;
  `cancel` in `src/recoveryPreload.js`.

### 3. Built-in mpv player

| Part                                                                                                                                        | File                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Native addon (libmpv render API drawing into an `NSOpenGLView` behind the web view; events and log messages to JS)                          | `native/mpv-bridge/`                                                                                  |
| Main-process player module, addon loading, mpv options                                                                                      | `src/modules/mpvPlayer.js`                                                                            |
| IPC handlers                                                                                                                                | `src/modules/ipcHandlers/mpvHandlers.js`                                                              |
| User `mpv.conf` (file in the profile folder, parser, blocked options)                                                                       | `src/modules/mpvConfig.js`                                                                            |
| Renderer adapter: a Lampa "tube" that makes mpv look like a `<video>` element; settings toggle; poster screen; backdrop hiding; "mpv" badge | `src/mpvTube.js`                                                                                      |
| Plumbing                                                                                                                                    | `src/preload.js`, `src/modules/pluginHandler.js`, `src/modules/windowManager.js` (transparent window) |

Behaviour:

- **Torrents:** when Lampa's torrent player is «Встроенный» (shown as
  «Встроенный (MPV)»), playback always goes through the built-in mpv.
- **Online and IPTV:** use Lampa's HTML5 player by default. Switch to mpv with
  Settings → «MPV и Загрузчик» → «Использовать mpv для онлайн» (`mpv_online_enabled`, default
  off; applies the next time a video opens).
- **mpv.conf:** Settings → «MPV и Загрузчик» → «Конфигурация mpv (mpv.conf)» opens an editor
  where you paste the contents of an mpv.conf. It is stored as
  `~/Library/Application Support/Lampa/mpv.conf` and stays until you change it
  (clearing the text deletes the file). It is applied before every video and wins
  over the app's own settings (e.g. `demuxer-readahead-secs` beats the buffer
  setting). A line removed from the file is undone (the previous value is
  restored). Supported: `option=value`, bare flags, `no-option`, `--option=value`,
  list suffixes (`-add`, `-append`, …), `#` comment lines. Ignored: `[profile]`
  sections and options that run code or break embedding (`script`, `include`,
  `input-ipc-server`, `ytdl*`, `vo`, `wid`, …); ignored lines are listed after
  saving.
- **Profiles:** the mpv.conf editor has a selector (main mpv.conf or a saved
  profile), «Сохранить как…» (saves the text as a named profile) and «Удалить».
  Profiles are plain files in `~/Library/Application Support/Lampa/mpv-profiles/`.
  While a video plays, press **P** to open a menu and pick a profile (or «Без
  профиля»): the options are sent to the running mpv through `setProperty` with no
  restart, and the previous values are restored when you switch or turn it off.
  The chosen profile is remembered (`mpv-active-profile`) and applied on top of
  mpv.conf for every following video; its options win over mpv.conf. Saving
  mpv.conf or the active profile also applies it to the video that is playing.
  The same blocked options apply; `change-list` operations (`-add`, `-append`, …)
  are not undone when a profile is taken off. IPC for scripts/plugins:
  `electronAPI.mpv.profiles / getProfile / saveProfile / deleteProfile /
applyProfile`.
- **AC3/EAC3 fallback:** Chromium's HTML5 player cannot decode AC3/EAC3. If an
  online stream plays without decoded audio (after about 1.5 s) or the HTML5 player
  fails fatally, the same link is reopened in mpv inside the running player, at the
  same position, with a short notice. One attempt per link.
- The external «MPV» entry is removed from the player lists (online, IPTV,
  torrents). Other external players (IINA, Infuse…) launch normally.
- Lampa's own title, panel, tracks, subtitles, resume and playlist work unchanged
  because the adapter provides the `<video>` API Lampa expects.
- mpv connects to streams directly with its own (ffmpeg) network stack; there is no
  local proxy. HTTPS is verified against the macOS CA bundle (`/etc/ssl/cert.pem`)
  and dropped connections are retried a bounded number of times. mpv does not use
  the macOS system proxy; to route it through one, add `http-proxy=…` to the
  mpv.conf editor. The Lampa page and the HTML5 player (Chromium) do follow the
  system proxy. The client has no proxy setting of its own.
- While a stream opens, a poster screen (backdrop, title, spinner) is shown; it is
  removed at the first picture. Clicking it cancels.
- While mpv plays, large full-screen elements at or below the player's layer
  (modals, plugin backdrops) are hidden and restored afterwards.
- A badge next to the resolution shows `mpv · VideoToolbox` (or `mpv · software`).
- **Buffer:** Settings → «MPV и Загрузчик» → «Буфер mpv» (15 s / 30 s / 60 s default / 2 min /
  5 min, `mpv_buffer_secs`), right below the online switch. It is mpv's demuxer
  cache in **RAM** (`cache=auto`, `cache-on-disk=no`; nothing is written to disk),
  capped at 512 MiB ahead (`demuxer-max-bytes`) plus mpv's default 50 MiB behind,
  so very high bitrate streams get less than the chosen time. After an underrun
  mpv resumes once about 8 s are queued (`cache-pause-wait=8`). Applies to the
  next video.

## Verified

- Hardware decoding (VideoToolbox) on a real 3832×1600 H.264 stream, 0 dropped
  frames, A/V sync about 0.
- zerocdn and srvkp HLS streams play in mpv (they failed earlier, see the TLS note
  below); seeking 30 minutes in worked.
- On local test files: pause/resume, seek, volume, speed, audio-track switching,
  subtitle show/hide, AC3 audio, fullscreen and resize.
- Player choice (checked in the running client): an online stream plays in the
  HTML5 `<video>`; a play call with `torrent_hash` plays in mpv (VideoToolbox,
  badge shown). The torrent case used an HLS URL, not a real TorrServer stream.
- Address editor: open, Cancel, bad address (error shown), restore the previous address.
- ESLint is clean on `src`.

- AC3/EAC3 fallback on generated test clips (mp4 AC3, mp4 EAC3, mkv AC3, HLS
  AC3): switches to mpv, AAC stays in HTML5. Not tried on real balancer streams.

## Not tested

- Torrent playback through TorrServer, and whether your "Tracks" window (a window
  left under the player) is hidden. Only a stand-in element was tested.
- Lampa's own torrent-preparation screen next to the new poster screen.
- DTS/EAC3, HEVC/HDR, 5.1 audio.
- Subtitle files supplied by Lampa or plugins (as opposed to embedded tracks).
- Whole-episode playback, resume position, next episode.
- Naming of audio tracks (your streams have mostly empty labels).
- No new automated tests were written, and the repo's existing tests were not run.

## Known problems

- No automatic quality switching for HLS; mpv picks the highest quality, so a slow
  CDN can still stall playback.
- `ao/coreaudio: unable to set the input channel layout` is logged at each file
  start. Audio plays; cause not investigated.
- One unexplained, non-reproduced failure of pause→play in an early test run.
- Cause of the earlier TLS failures on those CDNs: Homebrew's `openssl@4` had no
  certificate store (`/opt/homebrew/etc/openssl@4` missing after an interrupted
  install), so ffmpeg could not verify any HTTPS host. Fixed on this Mac with
  `brew postinstall openssl@4`; the app also points mpv at `/etc/ssl/cert.pem`.
  A fresh Mac with a healthy Homebrew should not hit it.
- Not available on the mpv path: picture-in-picture, volume normalization,
  zoom/fill picture modes.
- OpenGL is deprecated by Apple (works today).
- Address editor: opening it within seconds of launch can leave it hidden.
- There is no default address: the first launch shows the address window
  (`DEFAULT_LAMPA_URL` is empty). A new address is saved only after its page loads.

## Setting up on another Mac (Apple Silicon)

1. `brew install mpv` (libmpv comes from Homebrew) and Xcode Command Line Tools.
2. Node 24 (`>=24 <25`), then `corepack enable`.
3. In the repository: `yarn install`, then `yarn build:mpv-bridge` (builds the
   native addon with `node-gyp`; it links Homebrew's libmpv).
4. `yarn start`. The first launch asks for your Lampa/Lampac address.
5. Optional: copy `~/Library/Application Support/Lampa` from the old Mac to keep
   the address, login and `mpv.conf`.

## Required before this is an installable app

1. Bundle an **LGPL** libmpv (Homebrew's build is GPL; this repo is MIT), with
   `dylibbundler`, signing and notarization.
2. Add the addon build to `package.json` (`electron-builder` `asarUnpack`), and
   `node-addon-api` / `node-gyp` to `yarn.lock`.
3. Port the changes to the `macos/ac3-eac3` branch (macOS builds come from there;
   the last one is ac3.7).
4. Today it needs Homebrew's `mpv` installed and the addon built with
   `yarn build:mpv-bridge`.

## Notes on the local machine

- Homebrew `openssl@4` is linked from a `4.0.3.tmp` folder and `openssl@3` was
  unlinked by `brew link openssl@4`. Fragile; review it.
- Node 24.21.0 is unpacked in `~/lampa-desktop-src/toolchain` (not on PATH).
- The test app created `~/Library/Application Support/Lampa`.
- Proof of concept and test tools: `~/lampa-desktop-src/mpv-poc`.
- Lampa itself is not in the repo; the app loads it from the configured address.
  Two Lampa details this relies on: `Lampa.PlayerVideo.registerTube` and the
  one-argument `Element.prototype.append` override (use `appendChild`).
