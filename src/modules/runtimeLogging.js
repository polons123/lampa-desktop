const fs = require("node:fs");
const path = require("node:path");
const { format } = require("node:util");
const { app } = require("electron");
const folder = path.join(app.getPath("userData"), "logs");
const logFile = path.join(folder, "runtime.log");
const lastSamples = new Map();

function record(kind, value) {
  try {
    fs.mkdirSync(folder, { recursive: true });
    if (
      fs.existsSync(logFile) &&
      fs.statSync(logFile).size > 10 * 1024 * 1024
    ) {
      fs.renameSync(logFile, logFile + ".old");
    }
    fs.appendFileSync(
      logFile,
      `${new Date().toISOString()} [${kind}] ${value}\n`,
    );
  } catch {
    // Logging must never interrupt playback.
  }
}

for (const level of ["log", "info", "warn", "error", "debug"]) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    record(level, format(...args));
    original(...args);
  };
}
app.on("web-contents-created", (_event, contents) => {
  contents.on("console-message", (event, _level, message) => {
    record("renderer", event.message ?? message ?? "[empty message]");
  });
  contents.on("render-process-gone", (_event, details) => {
    record("renderer-exit", JSON.stringify(details));
  });
});
record("session", `started pid=${process.pid} version=${app.getVersion()}`);
console.info("Runtime log:", logFile);

function mpvEvent(event) {
  if (
    event.event === "property-change" &&
    ["time-pos", "demuxer-cache-time", "demuxer-cache-state"].includes(
      event.name,
    )
  ) {
    const now = Date.now();
    if (now - (lastSamples.get(event.name) || 0) < 5000) return;
    lastSamples.set(event.name, now);
  }
  record("mpv", JSON.stringify(event));
}
module.exports = { mpvEvent };
