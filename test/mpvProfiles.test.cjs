const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "lampa-mpv-prof-"));
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron")
    return {
      app: { getPath: () => userData, isPackaged: false, on() {}, once() {} },
    };
  if (request === "./runtimeLogging") return { mpvEvent() {} };
  return load.call(this, request, ...rest);
};
const mpvConfig = require("../src/modules/mpvConfig");
const mpv = require("../src/modules/mpvPlayer");
Module._load = load;

function fakeNative(initial) {
  const props = new Map(Object.entries(initial));
  return {
    props,
    getProperty: (name) => (props.has(name) ? props.get(name) : null),
    setProperty(name, value) {
      props.set(name, value);
      return 0;
    },
    command: () => 0,
  };
}

test("profile names are validated", () => {
  assert.ok(mpvConfig.validName("HDR 4K"));
  assert.ok(mpvConfig.validName("Кино-2"));
  for (const bad of ["", "../x", "a/b", ".hidden", "a ", "x".repeat(65)])
    assert.equal(mpvConfig.validName(bad), false, bad);
  assert.equal(mpvConfig.writeProfile(userData, "../x", "a=b").ok, false);
});

test("profiles are saved, listed, read and deleted", () => {
  assert.equal(
    mpvConfig.writeProfile(userData, "Яркий", "brightness=10").ok,
    true,
  );
  assert.equal(
    mpvConfig.writeProfile(userData, "Dark", "brightness=-10").ok,
    true,
  );
  assert.deepEqual(
    mpvConfig.listProfiles(userData).sort(),
    ["Dark", "Яркий"].sort(),
  );
  assert.equal(mpvConfig.readProfile(userData, "Dark"), "brightness=-10\n");
  assert.equal(mpvConfig.readProfile(userData, "nope"), null);
  assert.equal(mpvConfig.writeProfile(userData, "Empty", "  ").ok, false);
  mpvConfig.deleteProfile(userData, "Dark");
  assert.deepEqual(mpvConfig.listProfiles(userData), ["Яркий"]);
});

test("the active profile layers over mpv.conf and can be swapped live", () => {
  mpvConfig.write(userData, "brightness=2\nhwdec=videotoolbox\n");
  mpvConfig.writeProfile(userData, "A", "brightness=10\ncontrast=5");
  mpvConfig.writeProfile(userData, "B", "saturation=7");
  const native = fakeNative({
    brightness: "0",
    contrast: "0",
    saturation: "0",
    hwdec: "no",
  });

  mpvConfig.setActive(userData, "A");
  mpv.applyUserConfig(native, userData);
  assert.equal(native.props.get("brightness"), "10"); // profile beats mpv.conf
  assert.equal(native.props.get("contrast"), "5");
  assert.equal(native.props.get("hwdec"), "videotoolbox");

  mpvConfig.setActive(userData, "B");
  mpv.applyUserConfig(native, userData);
  assert.equal(native.props.get("brightness"), "2"); // back to mpv.conf value
  assert.equal(native.props.get("contrast"), "0"); // restored
  assert.equal(native.props.get("saturation"), "7");

  mpvConfig.setActive(userData, null);
  mpv.applyUserConfig(native, userData);
  assert.equal(native.props.get("saturation"), "0");
  assert.equal(native.props.get("brightness"), "2");
});

test("a deleted active profile is dropped", () => {
  mpvConfig.setActive(userData, "A");
  mpvConfig.deleteProfile(userData, "A");
  assert.equal(mpvConfig.getActive(userData), null);
});
