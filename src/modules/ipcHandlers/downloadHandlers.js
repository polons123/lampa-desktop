// modules/ipcHandlers/downloadHandlers.js
const { ipcMain } = require("electron");
const downloader = require("../downloader");

function registerDownloadHandlers(getMainWindow) {
  downloader.init(getMainWindow);
  // Only the Lampa window itself may start or control downloads.
  const guard =
    (handler, fallback) =>
    (event, ...args) => {
      const win = getMainWindow();
      if (!win || win.isDestroyed() || event.sender !== win.webContents)
        return fallback;
      return handler(...args);
    };
  const forbidden = { ok: false, error: "forbidden" };
  ipcMain.handle(
    "download:start",
    guard((options) => downloader.start(options || {}), forbidden),
  );
  ipcMain.handle(
    "download:list",
    guard(() => downloader.list(), []),
  );
  ipcMain.handle(
    "download:cancel",
    guard((id) => downloader.cancel(Number(id)), false),
  );
  ipcMain.handle(
    "download:remove",
    guard((id) => downloader.remove(Number(id)), false),
  );
  ipcMain.handle(
    "download:retry",
    guard((id) => downloader.retry(Number(id)), false),
  );
  ipcMain.handle(
    "download:reveal",
    guard((id) => downloader.reveal(Number(id)), false),
  );
  ipcMain.handle(
    "download:open-folder",
    guard(() => downloader.openFolder(), false),
  );
}

module.exports = registerDownloadHandlers;
