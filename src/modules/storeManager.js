// modules/storeManager.js
const Store = require("electron-store").default;
const { app } = require("electron");
const path = require("node:path");

const isDev =
  process.argv.includes("--dev") || process.env.NODE_ENV === "development";

let userDataPath;
if (isDev) {
  const devAppName = `${app.getName()}-Dev`;
  const originalUserData = app.getPath("userData");
  userDataPath = path.join(path.dirname(originalUserData), devAppName);
}

const store = new Store({
  cwd: userDataPath,
  defaults: {
    lampaUrl: "",
    fullscreenMode: "last",
    webSecurity: true,
    autoUpdate: false,
    windowState: {},
    tsVersion: null,
    tsPath: null,
    tsAutoStart: false,
    tsPort: 8090,
    tsUseGst: false,
    defaultPlayer: "vlc",
  },
});

store.set("autoUpdate", false);

console.log(`📁 Store location: ${store.path}`);

module.exports = store;
