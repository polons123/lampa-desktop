// modules/ipcHandlers/mpvHandlers.js
const { ipcMain } = require("electron");
const mpv = require("../mpvPlayer");

function registerMpvHandlers(getMainWindow) {
  ipcMain.handle("mpv:available", () => mpv.isAvailable());

  ipcMain.handle("mpv:open", async (_event, url, options) => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return { ok: false, error: "no window" };
    if (typeof url !== "string" || !/^(https?|file):\/\//i.test(url)) {
      return { ok: false, error: "unsupported url" };
    }
    try {
      return { ok: (await mpv.open(win, url, options || {})) >= 0 };
    } catch (error) {
      return { ok: false, error: String(error.message || error) };
    }
  });

  ipcMain.handle("mpv:command", (_event, args) =>
    Array.isArray(args) ? mpv.command(args.map(String)) : -1,
  );
  ipcMain.handle("mpv:get", (_event, name) => mpv.getProperty(String(name)));
  ipcMain.handle("mpv:set", (_event, name, value) =>
    mpv.setProperty(String(name), value),
  );
  ipcMain.handle("mpv:stop", () => mpv.stop());
}

module.exports = registerMpvHandlers;
