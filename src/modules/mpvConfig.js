// modules/mpvConfig.js
// User-editable mpv.conf for the built-in player. The text is kept in a plain
// file in the profile folder and stays there until the user changes it.
const fs = require("node:fs");
const path = require("node:path");

const MAX_BYTES = 64 * 1024;

// Options that would run code, read other files or break the embedded renderer.
const BLOCKED = new Set([
  "include",
  "config",
  "config-dir",
  "profile",
  "script",
  "scripts",
  "load-scripts",
  "js-memory-limit",
  "input-conf",
  "input-commands",
  "input-ipc-server",
  "input-ipc-client",
  "ytdl",
  "ytdl-format",
  "ytdl-raw-options",
  "vo",
  "wid",
  "gpu-context",
  "gpu-api",
  "force-window",
  "idle",
  "player-operation-mode",
]);

const LIST_OPS = new Set(["add", "append", "set", "pre", "clr", "remove"]);

function configPath(userData) {
  return path.join(userData, "mpv.conf");
}

function read(userData) {
  try {
    return fs.readFileSync(configPath(userData), "utf8");
  } catch {
    return "";
  }
}

function write(userData, text) {
  const file = configPath(userData);
  if (!text.trim()) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(file, text.endsWith("\n") ? text : text + "\n", "utf8");
}

function unquote(value) {
  const match = /^(["'])(.*)\1$/.exec(value);
  return match ? match[2] : value;
}

// Returns { entries: [{ name, value, op }], ignored: [{ line, text, reason }] }.
function parse(text) {
  const entries = [];
  const ignored = [];
  let inProfile = false;
  String(text)
    .split(/\r?\n/)
    .forEach((raw, index) => {
      const line = raw.trim();
      if (!line || line.startsWith("#")) return;
      const skip = (reason) =>
        ignored.push({ line: index + 1, text: line, reason });
      if (/^\[.*\]$/.test(line)) {
        inProfile = true;
        return skip("профили [секции] не поддерживаются");
      }
      if (inProfile) return skip("внутри профиля");
      const match = /^(?:--)?([A-Za-z0-9][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(
        line,
      );
      if (!match) return skip("не похоже на «опция=значение»");
      let name = match[1].toLowerCase();
      let value = match[2] === undefined ? undefined : unquote(match[2].trim());
      if (value === undefined) {
        if (name.startsWith("no-")) {
          name = name.slice(3);
          value = "no";
        } else value = "yes";
      }
      let op = null;
      const suffix = /^(.*)-([a-z]+)$/.exec(name);
      if (suffix && LIST_OPS.has(suffix[2])) {
        name = suffix[1];
        op = suffix[2];
      }
      if (BLOCKED.has(name)) return skip("опция запрещена");
      if (/[\0\n]/.test(value)) return skip("недопустимые символы");
      entries.push({ name, value, op });
    });
  return { entries, ignored };
}

// Named presets: each one is a plain mpv.conf-style file that can be applied
// to the running player on top of the main mpv.conf.
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u;
const MAX_PROFILES = 100;

function validName(name) {
  return typeof name === "string" && NAME_RE.test(name) && !name.endsWith(" ");
}

function profilesDir(userData) {
  return path.join(userData, "mpv-profiles");
}

function profilePath(userData, name) {
  return path.join(profilesDir(userData), name + ".conf");
}

function listProfiles(userData) {
  try {
    return fs
      .readdirSync(profilesDir(userData))
      .filter((file) => file.endsWith(".conf"))
      .map((file) => file.slice(0, -5))
      .filter(validName)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

// null when the name is invalid or the profile does not exist.
function readProfile(userData, name) {
  if (!validName(name)) return null;
  try {
    return fs.readFileSync(profilePath(userData, name), "utf8");
  } catch {
    return null;
  }
}

function writeProfile(userData, name, text) {
  if (!validName(name)) return { ok: false, error: "недопустимое имя" };
  if (typeof text !== "string" || !text.trim())
    return { ok: false, error: "пустой профиль" };
  if (Buffer.byteLength(text) > MAX_BYTES)
    return { ok: false, error: "слишком большой текст" };
  const existing = listProfiles(userData);
  if (!existing.includes(name) && existing.length >= MAX_PROFILES)
    return { ok: false, error: "слишком много профилей" };
  fs.mkdirSync(profilesDir(userData), { recursive: true });
  fs.writeFileSync(
    profilePath(userData, name),
    text.endsWith("\n") ? text : text + "\n",
    "utf8",
  );
  return { ok: true };
}

function deleteProfile(userData, name) {
  if (!validName(name)) return false;
  fs.rmSync(profilePath(userData, name), { force: true });
  return true;
}

// The profile applied on top of mpv.conf; it stays until the user changes it.
function activePath(userData) {
  return path.join(userData, "mpv-active-profile");
}

function getActive(userData) {
  try {
    const name = fs.readFileSync(activePath(userData), "utf8").trim();
    return validName(name) && readProfile(userData, name) !== null
      ? name
      : null;
  } catch {
    return null;
  }
}

function setActive(userData, name) {
  if (!name) return fs.rmSync(activePath(userData), { force: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(activePath(userData), name, "utf8");
}

module.exports = {
  configPath,
  read,
  write,
  parse,
  MAX_BYTES,
  validName,
  listProfiles,
  readProfile,
  writeProfile,
  deleteProfile,
  getActive,
  setActive,
};
