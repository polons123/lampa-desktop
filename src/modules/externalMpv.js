const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");

function parseMpvLink(link) {
  if (typeof link !== "string" || !link.startsWith("mpv://"))
    throw new Error("Invalid MPV link");
  const target = decodeURI(link.slice(6));
  const url = new URL(target);
  if (!["http:", "https:", "file:"].includes(url.protocol))
    throw new Error("Unsupported MPV media URL");
  return url.href;
}

async function openExternalMpv(link) {
  const url = parseMpvLink(link);
  const binary = ["/opt/homebrew/bin/mpv", "/usr/local/bin/mpv"].find(
    existsSync,
  );
  if (!binary) return Promise.reject(new Error("Внешний MPV не установлен."));
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["--", url], {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

module.exports = { openExternalMpv, parseMpvLink };
