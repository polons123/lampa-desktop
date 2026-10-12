// modules/ipcHandlers/mpvHandlers.js
const { ipcMain } = require("electron");
const { app } = require("electron");
const mpv = require("../mpvPlayer");
const mpvConfig = require("../mpvConfig");

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

  // mpv.conf: only the Lampa window itself may read or change it.
  const fromMainWindow = (event) => {
    const win = getMainWindow();
    return Boolean(
      win && !win.isDestroyed() && event.sender === win.webContents,
    );
  };
  ipcMain.handle("mpv:config-get", (event) => {
    if (!fromMainWindow(event)) return null;
    const userData = app.getPath("userData");
    return {
      text: mpvConfig.read(userData),
      path: mpvConfig.configPath(userData),
    };
  });
  ipcMain.handle("mpv:config-set", (event, text) => {
    if (!fromMainWindow(event)) return { ok: false, error: "forbidden" };
    if (
      typeof text !== "string" ||
      Buffer.byteLength(text) > mpvConfig.MAX_BYTES
    )
      return { ok: false, error: "слишком большой текст" };
    mpvConfig.write(app.getPath("userData"), text);
    const { entries, ignored } = mpvConfig.parse(text);
    return {
      ok: true,
      applied: entries.length,
      ignored,
      live: mpv.reapplyConfig(),
    };
  });

  // Profiles: named presets applied on top of mpv.conf. Changes reach the
  // running player at once (live: true); otherwise at the next video.
  const userData = () => app.getPath("userData");
  ipcMain.handle("mpv:profiles", (event) => {
    if (!fromMainWindow(event)) return null;
    return {
      names: mpvConfig.listProfiles(userData()),
      active: mpvConfig.getActive(userData()),
    };
  });
  ipcMain.handle("mpv:profile-get", (event, name) => {
    if (!fromMainWindow(event)) return null;
    return mpvConfig.readProfile(userData(), name);
  });
  ipcMain.handle("mpv:profile-save", (event, name, text) => {
    if (!fromMainWindow(event)) return { ok: false, error: "forbidden" };
    const result = mpvConfig.writeProfile(userData(), name, text);
    if (!result.ok) return result;
    const { entries, ignored } = mpvConfig.parse(text);
    // A change to the profile in use is applied to the running player now.
    const live =
      mpvConfig.getActive(userData()) === name ? mpv.reapplyConfig() : false;
    return { ok: true, applied: entries.length, ignored, live };
  });
  ipcMain.handle("mpv:profile-delete", (event, name) => {
    if (!fromMainWindow(event)) return { ok: false, error: "forbidden" };
    const wasActive = mpvConfig.getActive(userData()) === name;
    if (!mpvConfig.deleteProfile(userData(), name))
      return { ok: false, error: "недопустимое имя" };
    if (wasActive) mpvConfig.setActive(userData(), null);
    return { ok: true, live: wasActive ? mpv.reapplyConfig() : false };
  });
  // name = null takes the active profile off.
  ipcMain.handle("mpv:profile-apply", (event, name) => {
    if (!fromMainWindow(event)) return { ok: false, error: "forbidden" };
    if (name !== null && mpvConfig.readProfile(userData(), name) === null)
      return { ok: false, error: "профиль не найден" };
    mpvConfig.setActive(userData(), name);
    return { ok: true, live: mpv.reapplyConfig() };
  });
}

module.exports = registerMpvHandlers;
