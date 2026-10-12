// Application updates are deliberately disabled for this custom client.
// Keep the IPC contract, but never load electron-updater or schedule requests.
function setupAutoUpdater() {}

async function checkForAppUpdates() {
  return { status: "disabled", message: "Обновления приложения отключены." };
}

module.exports = { setupAutoUpdater, checkForAppUpdates };
