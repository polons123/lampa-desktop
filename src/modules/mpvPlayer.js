// modules/mpvPlayer.js
// Built-in mpv player (macOS): libmpv renders into a native view that sits
// behind the transparent Lampa web view. See native/mpv-bridge.
const path = require("node:path");
const { app } = require("electron");
const { existsSync } = require("node:fs");
const { mpvEvent } = require("./runtimeLogging");
const mpvConfig = require("./mpvConfig");

const OBSERVED = [
  "time-pos",
  "duration",
  "pause",
  "paused-for-cache",
  "seeking",
  "eof-reached",
  "track-list",
  "video-params",
  "hwdec-current",
  "demuxer-cache-time",
  "demuxer-cache-state",
  "volume",
];

let addon;
let addonError = null;
let attachedWindow = null;

function addonCandidates() {
  const rel = path.join(
    "native",
    "mpv-bridge",
    "build",
    "Release",
    "mpv_bridge.node",
  );
  const root = path.join(__dirname, "..", "..");
  return [
    path.join(root, rel),
    // electron-builder asarUnpack target
    path.join(root.replace("app.asar", "app.asar.unpacked"), rel),
    path.join(process.resourcesPath || "", "mpv", "mpv_bridge.node"),
  ];
}

function loadAddon() {
  if (addon || addonError) return addon || null;
  if (process.platform !== "darwin") {
    addonError = new Error("mpv built-in player is only supported on macOS");
    return null;
  }
  const file = addonCandidates().find((p) => existsSync(p));
  if (!file) {
    addonError = new Error("mpv_bridge.node not found");
    return null;
  }
  try {
    addon = require(file);
  } catch (error) {
    addonError = error;
  }
  return addon || null;
}

function isAvailable() {
  return Boolean(loadAddon());
}

function ensureAttached(win) {
  const native = loadAddon();
  if (!native) throw addonError || new Error("mpv unavailable");
  if (attachedWindow === win) return native;
  if (attachedWindow) {
    native.destroy();
    originals.clear();
    profileOriginals.clear();
  }
  native.attach(win.getNativeWindowHandle(), (event) => {
    mpvEvent(event);
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send("mpv:event", event);
  });
  OBSERVED.forEach((name, i) => native.observe(name, i + 1));
  // Variable-speed CDNs: read further ahead, and after an underrun wait for
  // some video to be queued instead of stuttering on every segment.
  native.setProperty("demuxer-readahead-secs", "60");
  native.setProperty("cache-pause-wait", "8");
  // Bound retries so a dropped connection can recover without hanging forever.
  const networkOptions = [
    "reconnect=1",
    "reconnect_on_network_error=1",
    "reconnect_delay_max=3",
    "reconnect_max_retries=3",
    "reconnect_delay_total_max=12",
  ];
  const configure = (name, value) => {
    const result = native.setProperty(name, value);
    if (result < 0) throw new Error("mpv rejected " + name + ": " + result);
  };
  configure("network-timeout", "15");
  configure("demuxer-lavf-propagate-opts", "yes");
  configure("stream-lavf-o", networkOptions.join(","));
  const demuxerOptions = [
    "http_persistent=0",
    "seg_max_retry=3",
    ...networkOptions,
  ];
  if (existsSync("/etc/ssl/cert.pem")) {
    configure("tls-ca-file", "/etc/ssl/cert.pem");
    configure("tls-verify", "yes");
    demuxerOptions.push("ca_file=/etc/ssl/cert.pem", "tls_verify=1");
  }
  configure("demuxer-lavf-o", demuxerOptions.join(","));
  attachedWindow = win;
  win.once("closed", () => {
    if (attachedWindow === win) shutdown();
  });
  return native;
}

// Options from the user's mpv.conf are applied before every file. Values that
// were overridden are remembered so a line removed from the file is undone.
const originals = new Map();
// The active profile sits on top of mpv.conf with its own memory, so it can be
// taken off again (or swapped for another) while a video is playing.
const profileOriginals = new Map();

function applyEntries(native, entries, store) {
  for (const { name, value, op } of entries) {
    let result;
    if (op) {
      result = native.command(["change-list", name, op, value]);
    } else {
      if (!store.has(name)) store.set(name, native.getProperty(name));
      result = native.setProperty(name, value);
    }
    if (result < 0)
      console.warn(`[mpv.conf] mpv rejected ${name}=${value} (${result})`);
  }
}

function revertEntries(native, store, keep = new Set()) {
  for (const [name, original] of store) {
    if (keep.has(name)) continue;
    if (original !== null) native.setProperty(name, original);
    store.delete(name);
  }
}

function applyUserConfig(native, userData) {
  // Order matters: take the profile off, bring mpv.conf up to date, put the
  // profile back on top.
  revertEntries(native, profileOriginals);
  const { entries } = mpvConfig.parse(mpvConfig.read(userData));
  revertEntries(
    native,
    originals,
    new Set(entries.filter((entry) => !entry.op).map((entry) => entry.name)),
  );
  applyEntries(native, entries, originals);
  const keys = new Set(entries.map((entry) => entry.name));
  const profile = mpvConfig.getActive(userData);
  if (profile) {
    const parsed = mpvConfig.parse(mpvConfig.readProfile(userData, profile));
    applyEntries(native, parsed.entries, profileOriginals);
    parsed.entries.forEach((entry) => keys.add(entry.name));
  }
  return keys;
}

// Applies the saved mpv.conf and active profile to the running player without
// opening a file or restarting anything. false when mpv is not running.
function reapplyConfig() {
  if (!attachedWindow) return false;
  try {
    applyUserConfig(loadAddon(), app.getPath("userData"));
    return true;
  } catch (error) {
    console.error("[mpv.conf] live apply failed:", error);
    return false;
  }
}

// options: { start?: seconds, headers?: {k: v}, volume?: 0..100 }
async function open(win, url, options = {}) {
  const native = ensureAttached(win);
  let userKeys = new Set();
  try {
    userKeys = applyUserConfig(native, app.getPath("userData"));
  } catch (error) {
    console.error("[mpv.conf] failed:", error);
  }
  const opts = [];
  if (options.start > 0) opts.push(`start=${options.start}`);
  if (options.headers) {
    const fields = Object.entries(options.headers)
      .map(([k, v]) => `${k}: ${v}`.replace(/,/g, "\\,"))
      .join(",");
    if (fields) opts.push(`http-header-fields=${fields}`);
  }
  for (const [key, value] of Object.entries(options.mpvOptions || {})) {
    // The user's mpv.conf wins over the values chosen by the app.
    if (/^[a-z0-9-]+$/.test(key) && !userKeys.has(key))
      opts.push(`${key}=${String(value).replace(/,/g, "")}`);
  }
  if (Number.isFinite(options.volume))
    native.setProperty("volume", String(options.volume));
  native.setProperty("pause", "no");
  // loadfile <url> <flags> <index> <options>: index -1 = default
  return native.command(["loadfile", url, "replace", "-1", opts.join(",")]);
}

function command(args) {
  return attachedWindow ? loadAddon().command(args) : -1;
}
function getProperty(name) {
  return attachedWindow ? loadAddon().getProperty(name) : null;
}
function setProperty(name, value) {
  return attachedWindow ? loadAddon().setProperty(name, String(value)) : -1;
}
function stop() {
  return command(["stop"]);
}
function shutdown() {
  if (!attachedWindow) return;
  attachedWindow = null;
  originals.clear();
  profileOriginals.clear();
  try {
    loadAddon().destroy();
  } catch (error) {
    console.error("mpv shutdown failed:", error);
  }
}

module.exports = {
  isAvailable,
  open,
  command,
  getProperty,
  setProperty,
  reapplyConfig,
  applyUserConfig,
  stop,
  shutdown,
};
