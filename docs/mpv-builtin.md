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
| Local HTTP bridge using Chromium's network stack (`net.fetch`), HLS playlist rewriting, Range support                                       | `src/modules/mpvProxy.js`                                                                             |
| Renderer adapter: a Lampa "tube" that makes mpv look like a `<video>` element; settings toggle; poster screen; backdrop hiding; "mpv" badge | `src/mpvTube.js`                                                                                      |
| Plumbing                                                                                                                                    | `src/preload.js`, `src/modules/pluginHandler.js`, `src/modules/windowManager.js` (transparent window) |

Behaviour:

- Replaces Lampa's «Встроенный» player **and** its «MPV» entry (an `mpv://` link
  that nothing on macOS handles). Other external players (IINA, Infuse…) still
  launch normally. Setting: Settings → Player → «Встроенный плеер mpv» (default on).
- Lampa's own title, panel, tracks, subtitles, resume and playlist work unchanged
  because the adapter provides the `<video>` API Lampa expects.
- Streams from public hosts go through the local proxy (fixes CDNs that reject
  mpv's own TLS client). Localhost and LAN addresses (TorrServer, NAS) play directly.
- While a stream opens, a poster screen (backdrop, title, spinner) is shown; it is
  removed at the first picture. Clicking it cancels.
- While mpv plays, large full-screen elements at or below the player's layer
  (modals, plugin backdrops) are hidden and restored afterwards.
- A badge next to the resolution shows `mpv · VideoToolbox` (or `mpv · software`).
- mpv buffers further ahead (`demuxer-readahead-secs=60`) and resumes after a
  stall only once about 8 s are queued (`cache-pause-wait=8`).

## Verified

- Hardware decoding (VideoToolbox) on a real 3832×1600 H.264 stream, 0 dropped
  frames, A/V sync about 0.
- zerocdn and srvkp HLS streams (failed with mpv's own network stack) play through
  the proxy; seeking 30 minutes in worked.
- On local test files: pause/resume, seek, volume, speed, audio-track switching,
  subtitle show/hide, AC3 audio, fullscreen and resize.
- Address editor: open, Cancel, bad address (error shown), restore lampa.mx.
- ESLint is clean on `src`.

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
- The root cause of mpv's own TLS failures on those CDNs is unknown (Chromium's
  works).
- Not available on the mpv path: picture-in-picture, volume normalization,
  zoom/fill picture modes.
- OpenGL is deprecated by Apple (works today).
- Address editor: opening it within seconds of launch can leave it hidden. A new
  address is stored before it is tried, so a typo persists until fixed.
- The app still starts on `http://lampa.mx` by default (`DEFAULT_LAMPA_URL` in
  `src/modules/pageNavigation.js`).

## Required before this is an installable app

1. Bundle an **LGPL** libmpv (Homebrew's build is GPL; this repo is MIT), with
   `dylibbundler`, signing and notarization.
2. Add the addon build to `package.json` (`electron-builder` `asarUnpack`), and
   `node-addon-api` / `node-gyp` to `yarn.lock`.
3. Port the changes to the `macos/ac3-eac3` branch (macOS builds come from there;
   the last one is ac3.7).
4. Today it needs Homebrew's `mpv` installed and the addon built by hand:
   `node-gyp rebuild` in `native/mpv-bridge` with Node 24.

## Notes on the local machine

- Homebrew `openssl@4` is linked from a `4.0.3.tmp` folder and `openssl@3` was
  unlinked by `brew link openssl@4`. Fragile; review it.
- Node 24.21.0 is unpacked in `~/lampa-desktop-src/toolchain` (not on PATH).
- The test app created `~/Library/Application Support/Lampa`.
- Proof of concept and test tools: `~/lampa-desktop-src/mpv-poc`.
- Lampa itself is not in the repo; the app loads it from the configured address.
  Two Lampa details this relies on: `Lampa.PlayerVideo.registerTube` and the
  one-argument `Element.prototype.append` override (use `appendChild`).
