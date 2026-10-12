// modules/downloader.js
// Downloads a film to the computer (~/Movies/Lampa) with an external program:
// yt-dlp (files and HLS/DASH) or curl (plain files).
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { app, shell } = require("electron");

const TOOLS = ["yt-dlp", "curl"];
const MAX_ACTIVE = 2;
const MAX_JOBS = 50;
const MAX_RETRIES = 5;
const EXTENSIONS = new Set([
  "mkv",
  "mp4",
  "m4v",
  "avi",
  "mov",
  "ts",
  "webm",
  "wmv",
  "flv",
  "mpg",
]);
const PLAYLIST_PATH = /\.(m3u8|mpd)$/i;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jobs = new Map();
let nextId = 1;
let getWindow = () => null;

function downloadsDir() {
  return path.join(app.getPath("home"), "Movies", "Lampa");
}

function sanitizeName(title) {
  const name = String(title || "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 120)
    .trim();
  return name || "Lampa";
}

function extensionFor(url, contentType) {
  try {
    const ext = path.extname(new URL(url).pathname).slice(1).toLowerCase();
    if (EXTENSIONS.has(ext)) return ext;
  } catch {
    /* fall through to the content type */
  }
  if (/matroska/i.test(contentType || "")) return "mkv";
  if (/mp4/i.test(contentType || "")) return "mp4";
  if (/webm/i.test(contentType || "")) return "webm";
  if (/mp2t/i.test(contentType || "")) return "ts";
  return "mkv";
}

// «Name.mkv», then «Name (2).mkv», … that exists neither as a file nor as a
// partial download.
function uniqueFile(dir, base, ext) {
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? `${base}.${ext}` : `${base} (${n}).${ext}`;
    const file = path.join(dir, name);
    const taken = [...jobs.values()].some((job) => job.file === file);
    if (!taken && !fs.existsSync(file) && !fs.existsSync(file + ".part"))
      return file;
  }
  return path.join(dir, `${base} ${Date.now()}.${ext}`);
}

function safeHeaders(headers) {
  const result = {};
  if (!headers || typeof headers !== "object") return result;
  for (const [key, value] of Object.entries(headers)) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(key) || typeof value !== "string")
      continue;
    // Range is ours; the rest must not smuggle extra header lines.
    if (/^range$/i.test(key) || /[\r\n\0]/.test(value)) continue;
    result[key] = value.slice(0, 4096);
  }
  return result;
}

function findTool(name) {
  const dirs = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    ...(process.env.PATH || "").split(path.delimiter).filter(Boolean),
  ];
  for (const dir of dirs) {
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch {
      /* try the next folder */
    }
  }
  return null;
}

function snapshot(job) {
  return {
    id: job.id,
    url: job.url,
    title: job.title,
    status: job.status,
    file: job.file ? path.basename(job.file) : null,
    received: job.received,
    total: job.total,
    // 0..1 or null when the size is unknown
    progress:
      job.total > 0
        ? Math.min(1, job.received / job.total)
        : job.duration > 0
          ? Math.min(1, job.time / job.duration)
          : null,
    speed: job.speed,
    error: job.error,
  };
}

function emit(job, force = false) {
  const now = Date.now();
  if (!force && now - job.lastEmit < 500) return;
  job.lastEmit = now;
  const win = getWindow();
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.send("download:update", snapshot(job));
}

function setStatus(job, status, error = null) {
  job.status = status;
  job.error = error;
  job.speed = 0;
  emit(job, true);
}

function trackSpeed(job) {
  const now = Date.now();
  if (!job.speedAt) {
    job.speedAt = now;
    job.speedBytes = job.received;
    return;
  }
  if (now - job.speedAt >= 1000) {
    job.speed = ((job.received - job.speedBytes) * 1000) / (now - job.speedAt);
    job.speedAt = now;
    job.speedBytes = job.received;
  }
}

function discardPartial(job) {
  if (job.base) {
    // External tools leave «base.ext.part», «.ytdl» and fragment files.
    const dir = downloadsDir();
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names)
      if (
        name.startsWith(job.base + ".") &&
        /\.(part|ytdl|temp)(-|$|\.)/.test(name)
      )
        fs.rm(path.join(dir, name), { force: true }, () => {});
    return;
  }
  if (job.file) fs.rm(job.file + ".part", { force: true }, () => {});
}

function finish(job) {
  fs.renameSync(job.file + ".part", job.file);
  job.received = fs.statSync(job.file).size;
  job.total = job.total || job.received;
  setStatus(job, "done");
}

// «Name», «Name (2)», … with no file of that name (any extension) in the
// folder and no other job using it.
function uniqueBase(dir, title) {
  const base = sanitizeName(title);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    /* the folder does not exist yet */
  }
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? base : `${base} (${n})`;
    const taken =
      [...jobs.values()].some((job) => job.base === name) ||
      names.some((file) => file.startsWith(name + "."));
    if (!taken) return name;
  }
  return `${base} ${Date.now()}`;
}

function spawnTool(job, command, args, onStdout) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    job.cancel = () => child.kill("SIGTERM");
    let buffer = "";
    let tail = "";
    child.stdout.on("data", (data) => {
      buffer += data;
      const lines = buffer.split(/\r?\n|\r/);
      buffer = lines.pop();
      lines.forEach(onStdout);
    });
    child.stderr.on("data", (data) => {
      tail = (tail + data).slice(-2000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (buffer) onStdout(buffer);
      if (job.status === "canceled") return reject(new Error("canceled"));
      if (code === 0) return resolve();
      const lines = tail.trim().split("\n").filter(Boolean);
      const reason =
        lines.reverse().find((line) => /error/i.test(line)) ||
        lines[0] ||
        `${path.basename(command)}: код ${code}`;
      reject(new Error(reason.replace(/^ERROR:\s*/i, "")));
    });
  });
}

const num = (value) => (/^\d+(\.\d+)?$/.test(value) ? Number(value) : 0);

async function runYtDlp(job) {
  const tool = findTool("yt-dlp");
  if (!tool)
    throw new Error("yt-dlp не найден (установите: brew install yt-dlp)");
  const dir = downloadsDir();
  fs.mkdirSync(dir, { recursive: true });
  job.base = job.base || uniqueBase(dir, job.title);
  const args = [
    "--no-playlist",
    "--no-colors",
    "--newline",
    "--no-quiet",
    "--progress",
    "--retries",
    "5",
    "--fragment-retries",
    "5",
    "--concurrent-fragments",
    "4",
    "--merge-output-format",
    "mkv",
    "--progress-template",
    "download:LAMPA %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s",
    "--print",
    "after_move:filepath",
    "-o",
    path.join(dir, job.base.replace(/%/g, "%%") + ".%(ext)s"),
  ];
  for (const [key, value] of Object.entries(job.headers))
    args.push("--add-header", `${key}:${value}`);
  args.push("--", job.url);
  await spawnTool(job, tool, args, (line) => {
    const progress = /^LAMPA (\S+) (\S+) (\S+) (\S+)/.exec(line);
    if (progress) {
      job.received = num(progress[1]);
      job.total = num(progress[2]) || num(progress[3]);
      job.speed = num(progress[4]);
      return emit(job);
    }
    const file = line.trim();
    if (
      path.isAbsolute(file) &&
      path.dirname(file) === dir &&
      fs.existsSync(file)
    )
      job.file = file;
  });
  if (!job.file) throw new Error("yt-dlp не сообщил имя файла");
  job.received = fs.statSync(job.file).size;
  job.total = job.received;
  setStatus(job, "done");
}

async function runCurl(job) {
  const tool = findTool("curl");
  if (!tool) throw new Error("curl не найден");
  if (PLAYLIST_PATH.test(safePathname(job.url)))
    throw new Error("плейлисты (m3u8/mpd) скачивает только yt-dlp");
  if (!job.file)
    job.file = uniqueFile(
      downloadsDir(),
      sanitizeName(job.title),
      extensionFor(job.url, ""),
    );
  fs.mkdirSync(path.dirname(job.file), { recursive: true });
  const part = job.file + ".part";
  const headerArgs = Object.entries(job.headers).flatMap(([k, v]) => [
    "-H",
    `${k}: ${v}`,
  ]);
  // Total size, best effort: the last Content-Length of a HEAD request.
  if (!job.total) {
    await new Promise((resolve) => {
      let out = "";
      const head = spawn(
        tool,
        ["-sIL", "--max-time", "8", ...headerArgs, "--url", job.url],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      head.stdout.on("data", (data) => (out += data));
      head.on("error", resolve);
      head.on("close", () => {
        const all = [...out.matchAll(/^content-length:\s*(\d+)/gim)];
        if (all.length) job.total = Number(all[all.length - 1][1]);
        resolve();
      });
    });
  }
  // curl prints no machine-readable progress; follow the size of the file.
  const timer = setInterval(() => {
    try {
      job.received = fs.statSync(part).size;
      trackSpeed(job);
      emit(job);
    } catch {
      /* not created yet */
    }
  }, 500);
  const args = [
    "--location",
    "--fail",
    "--silent",
    "--show-error",
    "-C",
    "-",
    "-o",
    part,
    ...headerArgs,
    "--url",
    job.url,
  ];
  // curl's own --retry does not resume after a dropped connection, so start it
  // again (it continues from the size of the .part file) a few times.
  let failures = 0;
  try {
    for (;;) {
      try {
        await spawnTool(job, tool, args, () => {});
        break;
      } catch (error) {
        const size = fs.existsSync(part) ? fs.statSync(part).size : 0;
        if (size > job.received) failures = 0;
        // HTTP errors (curl --fail) will not get better by waiting.
        if (job.status === "canceled" || /error: [45]\d\d/.test(error.message))
          throw error;
        if (++failures > MAX_RETRIES) throw error;
        await wait(Math.min(2000 * failures, 10000));
      }
    }
  } finally {
    clearInterval(timer);
  }
  finish(job);
}

async function run(job) {
  try {
    if (job.tool === "yt-dlp") await runYtDlp(job);
    else await runCurl(job);
  } catch (error) {
    if (job.status === "canceled") return;
    // Nothing useful was written: do not leave an empty partial file behind.
    if (job.received === 0) discardPartial(job);
    setStatus(job, "error", String(error.message || error));
  } finally {
    job.cancel = null;
    pump();
  }
}

function safePathname(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

function pump() {
  const active = [...jobs.values()].filter((job) => job.status === "active");
  let free = MAX_ACTIVE - active.length;
  for (const job of jobs.values()) {
    if (free <= 0) break;
    if (job.status !== "queued") continue;
    job.status = "active";
    emit(job, true);
    free--;
    void run(job);
  }
}

function start({ url, title, headers, tool }) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url))
    return { ok: false, error: "поддерживаются только http(s)-ссылки" };
  const chosen = tool || availableTools()[0]?.id || TOOLS[0];
  if (!TOOLS.includes(chosen))
    return { ok: false, error: "загрузчик недоступен" };
  if (!findTool(chosen))
    return {
      ok: false,
      error: `${chosen} не найден (установите: brew install ${chosen})`,
    };
  const live = [...jobs.values()].find(
    (job) =>
      job.url === url && ["queued", "active", "done"].includes(job.status),
  );
  if (live && live.status !== "done")
    return { ok: true, id: live.id, existing: true };
  if (jobs.size >= MAX_JOBS) {
    for (const [id, job] of jobs)
      if (["done", "error", "canceled"].includes(job.status)) jobs.delete(id);
    if (jobs.size >= MAX_JOBS)
      return { ok: false, error: "слишком много загрузок" };
  }
  const job = {
    id: nextId++,
    url,
    title: String(title || "").slice(0, 200) || "Lampa",
    headers: safeHeaders(headers),
    tool: chosen,
    base: null,
    status: "queued",
    file: null,
    received: 0,
    total: 0,
    duration: 0,
    time: 0,
    speed: 0,
    speedAt: 0,
    speedBytes: 0,
    error: null,
    lastEmit: 0,
    cancel: null,
  };
  jobs.set(job.id, job);
  emit(job, true);
  pump();
  return { ok: true, id: job.id };
}

// External downloaders: which are installed, in order of preference.
function availableTools() {
  return TOOLS.map((id) => ({ id, available: Boolean(findTool(id)) })).filter(
    (item) => item.available,
  );
}

function tools() {
  return {
    all: TOOLS.map((id) => ({ id, available: Boolean(findTool(id)) })),
  };
}

function list() {
  return [...jobs.values()].map(snapshot);
}

function cancel(id) {
  const job = jobs.get(id);
  if (!job || !["queued", "active"].includes(job.status)) return false;
  const wasActive = job.status === "active";
  job.status = "canceled";
  job.error = null;
  job.speed = 0;
  if (wasActive) job.cancel?.();
  discardPartial(job);
  emit(job, true);
  return true;
}

// Removes a finished/failed/canceled entry from the list (the file stays).
function remove(id) {
  const job = jobs.get(id);
  if (!job || ["queued", "active"].includes(job.status)) return false;
  if (job.status !== "done") discardPartial(job);
  jobs.delete(id);
  return true;
}

function retry(id) {
  const job = jobs.get(id);
  if (!job || !["error", "canceled"].includes(job.status)) return false;
  // Resume from what is on disk when the partial file is still there.
  let size = 0;
  try {
    size = job.file ? fs.statSync(job.file + ".part").size : 0;
  } catch {
    size = 0;
  }
  job.received = size;
  job.error = null;
  job.status = "queued";
  emit(job, true);
  pump();
  return true;
}

function reveal(id) {
  const job = jobs.get(id);
  if (!job?.file) return false;
  const target = job.status === "done" ? job.file : job.file + ".part";
  if (fs.existsSync(target)) shell.showItemInFolder(target);
  else void shell.openPath(downloadsDir());
  return true;
}

async function openFolder() {
  fs.mkdirSync(downloadsDir(), { recursive: true });
  return (await shell.openPath(downloadsDir())) === "";
}

function init(windowGetter) {
  getWindow = windowGetter;
  app.on("before-quit", () => {
    for (const job of jobs.values()) {
      if (job.status === "active") {
        job.status = "canceled";
        job.cancel?.();
      }
    }
  });
}

module.exports = {
  init,
  start,
  list,
  tools,
  cancel,
  remove,
  retry,
  reveal,
  openFolder,
  sanitizeName,
  extensionFor,
  safeHeaders,
};
