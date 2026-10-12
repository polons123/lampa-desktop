// modules/ipcHandlers/index.js
const store = require("../storeManager");
const { getMainWindow } = require("../windowManager");
const { injectPlugin } = require("../pluginHandler");

const registerStoreHandlers = require("./storeHandlers");
const registerProcessHandlers = require("./processHandlers");
const registerWindowHandlers = require("./windowHandlers");
const { registerSettingsHandlers } = require("./settingsHandlers");
const registerCloudHandlers = require("./cloudHandlers");
const registerTorrServerHandlers = require("./torrServerHandlers");
const registerFolderHandlers = require("./folderHandlers");
const registerPlayerHandlers = require("./playerHandlers");
const registerMpvHandlers = require("./mpvHandlers");
const registerDownloadHandlers = require("./downloadHandlers");
const registerOtherHandlers = require("./otherHandlers");
const registerSubtitleHandlers = require("./subtitleHandlers");

function registerIpcHandlers() {
  // Базовые обработчики store
  registerStoreHandlers(store);

  // Обработчики для процессов (spawn, fs)
  registerProcessHandlers();

  // Обработчики для управления окном
  registerWindowHandlers(getMainWindow);

  // Обработчики для экспорта/импорта настроек
  registerSettingsHandlers(store, getMainWindow, injectPlugin);

  // Обработчики для облачного экспорта/импорта
  registerCloudHandlers(store, getMainWindow, injectPlugin);

  // Обработчики для TorrServer
  registerTorrServerHandlers();

  // Обработчики для работы с папками
  registerFolderHandlers();

  // Плееры
  registerPlayerHandlers();

  // Встроенный плеер mpv (macOS)
  registerMpvHandlers(getMainWindow);

  // Скачивание фильмов на компьютер
  registerDownloadHandlers(getMainWindow);

  // Дополнительные обработчики
  registerOtherHandlers();
  registerSubtitleHandlers(getMainWindow);
}

module.exports = {
  registerIpcHandlers,
};
