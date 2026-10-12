const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const file = path.join(__dirname, "../src/modules/autoUpdater.js");

test("application updates are disabled and never load electron-updater", async () => {
  assert.doesNotMatch(
    fs.readFileSync(file, "utf8"),
    /require\(["']electron-updater/,
  );
  const { setupAutoUpdater, checkForAppUpdates } = require(file);
  assert.equal(setupAutoUpdater(), undefined);
  assert.equal((await checkForAppUpdates()).status, "disabled");
});
