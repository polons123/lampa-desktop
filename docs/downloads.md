# Downloading a film to the computer

Files are saved to `~/Movies/Lampa` (the folder is created on demand) as
`Title (year) - episode.mkv`; a repeated title gets ` (2)`, ` (3)`, …

## Use

- While a video plays, press the **download** button (arrow) in Lampa's player
  panel, next to the settings button. It downloads the link Lampa is playing
  (TorrServer streams included).
- Settings → **MPV и Загрузчик** → **Загрузки** lists downloads with progress, speed, cancel,
  retry, «Показать» (Finder) and «Открыть папку».

## How it works

- `src/modules/downloader.js` (main process). At most two downloads run at once,
  the rest wait in a queue. Downloads go to an **external program**, chosen in
  Settings → «MPV и Загрузчик» → «Загрузчик» (Auto = yt-dlp, else curl):
  - **yt-dlp** (`brew install yt-dlp`): direct files and HLS/DASH playlists
    (merged into mkv/mp4). Progress comes from its `--progress-template`;
    headers are passed with `--add-header`; an interrupted download resumes.
  - **curl**: plain files only (no playlists). Resumes with `-C -` (the app restarts curl up to 5 times after a dropped
    connection);
    progress follows the size of `name.ext.part`, the total comes from a HEAD
    request when the server answers it.
- The program is started without a shell, with the link after `--` / `--url`, so
  a link cannot inject options. Only `yt-dlp` and `curl` are accepted.
- Cancelling removes the partial files; a failed download keeps them so
  «Повторить» can resume. The list lives only until the app quits.
- IPC (`electronAPI.downloads`): `start({url, title, headers, tool})`, `tools`,
  `list`, `cancel`, `remove`, `retry`, `reveal`, `openFolder`, `onUpdate`. Only
  the Lampa window may call it; only `http(s)` links are accepted.
