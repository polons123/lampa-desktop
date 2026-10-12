// Downloading a film to the computer (~/Movies/Lampa).
// Adds a «Скачать» button to Lampa's player panel and a «Загрузки» list to the
// player settings. The work itself happens in the main process
// (src/modules/downloader.js).
(function () {
  const api = window.electronAPI?.downloads;
  const Lampa = window.Lampa;
  if (!api || !Lampa?.Player || window.desktopDownloadsInstalled) return;
  window.desktopDownloadsInstalled = true;

  // Settings page «MPV и Загрузчик», shown under «Плеер». Created by whichever of
  // the two scripts (mpvTube.js, downloads.js) loads first.
  const SETTINGS_COMPONENT = "mpv_downloader";
  function ensureSettingsComponent() {
    if (window.desktopMpvDlComponent) return;
    window.desktopMpvDlComponent = true;
    Lampa.Lang.add({
      app_settings_mpv_dl: { ru: "MPV и Загрузчик", en: "MPV and Downloader" },
    });
    Lampa.SettingsApi.addComponent({
      component: SETTINGS_COMPONENT,
      name: Lampa.Lang.translate("app_settings_mpv_dl"),
      icon:
        '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor">' +
        '<path d="M8 5v14l11-7L8 5zM5 20h14v2H5z"/></svg>',
    });
    // New pages are appended to the end of the list; move this one under «Плеер».
    Lampa.Settings.listener.follow("open", (event) => {
      if (event.name !== "main") return;
      const mine = event.body.find(`[data-component="${SETTINGS_COMPONENT}"]`);
      const player = event.body.find('[data-component="player"]');
      if (mine.length && player.length) player.after(mine);
    });
  }
  ensureSettingsComponent();

  const LIST_BUTTON = "desktop_downloads_list";
  const TOOL_SETTING = "desktop_download_tool";
  const STATUS_ROW = "desktop_download_status";
  const CANCEL_BUTTON = "desktop_download_cancel";
  const t = (key) => Lampa.Lang.translate(key);
  const toast = (text) =>
    window.desktopToast ? window.desktopToast(text) : Lampa.Noty.show(text);
  const jobs = new Map(); // id -> latest snapshot from the main process
  let render = null; // redraws the open list, if any

  Lampa.Lang.add({
    app_downloads_cancel_current: {
      ru: "Отменить загрузку",
      en: "Cancel download",
    },
    app_downloads_cancel_current_descr: {
      ru: "Останавливает загрузку из строки выше и удаляет недокачанный файл.",
      en: "Stops the download shown above and removes the partial file.",
    },
    app_downloads_nothing: {
      ru: "Нет активной загрузки",
      en: "No active download",
    },
    app_downloads_canceled_note: {
      ru: "Загрузка отменена: ",
      en: "Canceled: ",
    },
    app_downloads_menu: { ru: "Загрузить", en: "Download" },
    app_downloads_menu_descr: {
      ru: "Скачать на компьютер вместо просмотра",
      en: "Save to this computer instead of watching",
    },
    app_downloads_pick: {
      ru: "Выберите файл или качество: оно будет скачано вместо просмотра",
      en: "Pick the file or quality: it will be downloaded instead of played",
    },
    app_downloads_status: { ru: "Текущая загрузка", en: "Current download" },
    app_downloads_title: { ru: "Загрузки", en: "Downloads" },
    app_downloads_descr: {
      ru: "Фильмы, скачанные на компьютер, сохраняются в ~/Movies/Lampa.",
      en: "Films saved to this computer go to ~/Movies/Lampa.",
    },
    app_downloads_tool: { ru: "Загрузчик", en: "Downloader" },
    app_downloads_tool_descr: {
      ru: "Внешняя программа, которая скачивает видео: yt-dlp (файлы и HLS/DASH) или curl (только обычные файлы). «Авто» берёт yt-dlp, а если его нет, curl.",
      en: "The external program that downloads the video: yt-dlp (files and HLS/DASH) or curl (plain files only). Auto picks yt-dlp, then curl.",
    },
    app_downloads_tool_auto: { ru: "Авто", en: "Auto" },
    app_downloads_button: { ru: "Скачать", en: "Download" },
    app_downloads_started: {
      ru: "Загрузка начата: ",
      en: "Download started: ",
    },
    app_downloads_done: { ru: "Загрузка завершена: ", en: "Downloaded: " },
    app_downloads_failed: { ru: "Ошибка загрузки: ", en: "Download failed: " },
    app_downloads_no_url: {
      ru: "Не удалось определить ссылку на видео",
      en: "Could not find the video link",
    },
    app_downloads_empty: {
      ru: "Пока ничего не скачивается",
      en: "Nothing yet",
    },
    app_downloads_queued: { ru: "В очереди", en: "Queued" },
    app_downloads_canceled: { ru: "Отменено", en: "Canceled" },
    app_downloads_cancel: { ru: "Отмена", en: "Cancel" },
    app_downloads_retry: { ru: "Повторить", en: "Retry" },
    app_downloads_show: { ru: "Показать", en: "Show" },
    app_downloads_remove: { ru: "Убрать", en: "Remove" },
    app_downloads_folder: { ru: "Открыть папку", en: "Open folder" },
    app_downloads_close: { ru: "Закрыть", en: "Close" },
  });

  const mb = (bytes) =>
    bytes >= 1073741824
      ? (bytes / 1073741824).toFixed(2) + " ГБ"
      : (bytes / 1048576).toFixed(0) + " МБ";

  function describe(job) {
    if (job.status === "queued") return t("app_downloads_queued");
    if (job.status === "canceled") return t("app_downloads_canceled");
    if (job.status === "error") return job.error || "";
    const size = job.total
      ? `${mb(job.received)} / ${mb(job.total)}`
      : mb(job.received);
    if (job.status === "done") return size;
    const percent =
      job.progress === null ? "" : Math.round(job.progress * 100) + "% · ";
    const speed =
      job.speed > 0 ? ` · ${(job.speed / 1048576).toFixed(1)} МБ/с` : "";
    return percent + size + speed;
  }

  // «Name (year) - episode», from the card Lampa is showing and the play data.
  function titleFor(work) {
    const card = Lampa.Activity?.active?.()?.card || work.movie || {};
    const base = card.title || card.name || work.title || "Lampa";
    const date = card.release_date || card.first_air_date || "";
    const year = /^\d{4}/.test(date) ? ` (${date.slice(0, 4)})` : "";
    const extra =
      work.title && work.title !== base && !base.includes(work.title)
        ? ` - ${work.title}`
        : "";
    return base + year + extra;
  }

  function chosenTool() {
    const tool = Lampa.Storage.get(TOOL_SETTING, "auto");
    return tool && tool !== "auto" ? String(tool) : undefined;
  }

  async function startDownload(data) {
    const work = data || Lampa.Player.playdata?.();
    if (!work) return toast(t("app_downloads_no_url"));
    // hls.js shows a blob: URL in the element; the original link is in the data.
    const raw = work?.url;
    const url = (raw && Lampa.Torserver?.toPlayUrl?.(raw)) || raw;
    if (!url || !/^https?:\/\//i.test(String(url)))
      return toast(t("app_downloads_no_url"));
    const title = titleFor(work);
    const result = await api
      .start({
        url: String(url),
        title,
        headers: work.headers || undefined,
        tool: chosenTool(),
      })
      .catch(() => null);
    if (!result?.ok)
      return toast(t("app_downloads_failed") + (result?.error || title));
    toast(t("app_downloads_started") + title);
  }

  // Progress next to the button: «42%» while the video that is playing is being
  // downloaded, «✓» when done; with other downloads running, the latest one.
  function currentUrl() {
    const raw = Lampa.Player.playdata?.()?.url;
    return (raw && Lampa.Torserver?.toPlayUrl?.(raw)) || raw || "";
  }
  function badgeText() {
    const all = [...jobs.values()].sort((a, b) => b.id - a.id);
    const url = currentUrl();
    const running = (job) => ["active", "queued"].includes(job.status);
    const job =
      all.find((item) => item.url === url && running(item)) ||
      all.find(running) ||
      all.find((item) => item.url === url && item.status === "done");
    if (!job) return "";
    if (job.status === "done") return "✓";
    if (job.status === "queued") return "…";
    return job.progress === null ? "…" : Math.round(job.progress * 100) + "%";
  }
  function updateBadge() {
    const badge = document.querySelector(".desktop-download-button__badge");
    if (badge) badge.textContent = badgeText();
  }

  const noted = new Set(); // finished/failed jobs that were already announced
  api.onUpdate((job) => {
    jobs.set(job.id, job);
    if (["done", "error"].includes(job.status) && !noted.has(job.id)) {
      noted.add(job.id);
      toast(
        t(
          job.status === "done" ? "app_downloads_done" : "app_downloads_failed",
        ) +
          job.title +
          (job.status === "error" && job.error ? ` (${job.error})` : ""),
      );
    }
    render?.();
    updateBadge();
    updateStatusRow();
  });
  api
    .list()
    .then((list) => list.forEach((job) => jobs.set(job.id, job)))
    .catch(() => {});

  // --- «Загрузить» in the context menu of online sources and torrents --------
  // The menu is built by Lampa (long press / right click on an item) and does
  // not expose the item's link. So «Загрузить» opens the item as usual and the
  // next Player.play with a real link becomes a download instead of playback.
  const PENDING_MS = 90000;
  let pending = null; // { until }

  for (const method of ["play", "iptv"]) {
    const original = Lampa.Player[method];
    if (typeof original !== "function") continue;
    Lampa.Player[method] = function (data) {
      if (
        pending &&
        Date.now() < pending.until &&
        /^https?:\/\//i.test(String(data?.url || ""))
      ) {
        pending = null;
        void startDownload(data);
        return;
      }
      return original.apply(this, arguments);
    };
  }

  const selectShow = Lampa.Select.show;
  Lampa.Select.show = function (params) {
    try {
      const focus = document.querySelector(".selector.focus");
      const isAction =
        params?.title === Lampa.Lang.translate("title_action") ||
        params?.title === "Действие";
      // Only the item menus of online sources and torrents.
      if (
        isAction &&
        Array.isArray(params.items) &&
        focus &&
        /torrent-item|online/.test(focus.className)
      ) {
        const back = Lampa.Controller.enabled?.().name;
        const handler = params.onSelect;
        params = {
          ...params,
          items: [
            {
              title: t("app_downloads_menu"),
              subtitle: t("app_downloads_menu_descr"),
              download: true,
            },
            ...params.items,
          ],
          onSelect: (item) => {
            if (!item?.download) return handler?.(item);
            if (back) Lampa.Controller.toggle(back);
            pending = { until: Date.now() + PENDING_MS };
            toast(t("app_downloads_pick"));
            // Let the menu close first, then open the item as a click would.
            setTimeout(() => window.$?.(focus).trigger("hover:enter"), 150);
          },
        };
      }
    } catch (error) {
      console.error("[downloads] menu item failed:", String(error));
    }
    return selectShow.call(this, params);
  };

  // --- Player panel button -------------------------------------------------
  function addPanelButton() {
    if (!Lampa.Player.opened?.()) return;
    const panel = document.querySelector(".player-panel");
    if (!panel || panel.querySelector(".desktop-download-button")) return;
    const anchor =
      panel.querySelector(".player-panel__settings") ||
      panel.querySelector(".player-panel__playlist");
    if (!anchor?.parentElement) return;
    const button = document.createElement("div");
    button.className =
      "player-panel__download desktop-download-button button selector";
    button.title = t("app_downloads_button");
    button.innerHTML =
      '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor">' +
      '<path d="M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z"/></svg>' +
      '<span class="desktop-download-button__badge"></span>';
    // Lampa turns a click on a .selector into hover:enter.
    window.$?.(button).on("hover:enter", () => void startDownload());
    anchor.after(button);
    ensureStyle();
    updateBadge();
  }
  setInterval(() => {
    addPanelButton();
    updateBadge();
  }, 1000);

  // --- Downloads list ------------------------------------------------------
  function ensureStyle() {
    if (document.getElementById("desktop-downloads-style")) return;
    const style = document.createElement("style");
    style.id = "desktop-downloads-style";
    style.textContent = `
      .desktop-download-button { position: relative; }
      .desktop-download-button__badge { position: absolute; left: 50%; bottom: -0.2em;
        transform: translateX(-50%); font-size: 0.55em; line-height: 1; white-space: nowrap;
        padding: 0.2em 0.4em; border-radius: 0.6em; background: rgba(0, 0, 0, 0.65);
        color: #fff; pointer-events: none; }
      .desktop-download-button__badge:empty { display: none; }
      .dl-list { position: fixed; inset: 0; z-index: 120; display: flex;
        align-items: center; justify-content: center;
        background: rgba(0, 0, 0, 0.75); color: #fff; }
      .dl-list__box { width: min(90%, 52em); max-height: 90%; display: flex;
        flex-direction: column; gap: 0.8em; padding: 1.6em; border-radius: 1em;
        background: rgba(30, 30, 30, 0.95); }
      .dl-list__title { font-size: 1.5em; }
      .dl-list__items { overflow: auto; display: flex; flex-direction: column; gap: 0.8em; }
      .dl-list__empty { opacity: 0.7; padding: 1em 0; }
      .dl-item { padding: 0.8em 1em; border-radius: 0.6em; background: rgba(255, 255, 255, 0.08); }
      .dl-item__name { overflow-wrap: anywhere; }
      .dl-item__info { font-size: 0.9em; opacity: 0.7; margin: 0.3em 0; overflow-wrap: anywhere; }
      .dl-item__bar { height: 0.35em; border-radius: 0.2em; background: rgba(255, 255, 255, 0.15); overflow: hidden; }
      .dl-item__fill { height: 100%; background: #fff; }
      .dl-item__buttons { display: flex; gap: 0.6em; margin-top: 0.6em; flex-wrap: wrap; }
      .dl-list button { padding: 0.5em 1.2em; border: 0; border-radius: 0.6em;
        background: rgba(255, 255, 255, 0.15); color: #fff; font-size: 1em; cursor: pointer; }
      .dl-list button:hover, .dl-list button:focus { background: rgba(255, 255, 255, 0.3); outline: 0; }
      .dl-list__buttons { display: flex; gap: 0.8em; justify-content: flex-end; }`;
    document.head.appendChild(style);
  }

  function button(act, id, key) {
    const el = document.createElement("button");
    el.dataset.act = act;
    el.dataset.id = id;
    el.textContent = t(key);
    return el;
  }

  async function openList() {
    if (document.querySelector(".dl-list")) return;
    ensureStyle();
    const list = await api.list().catch(() => []);
    list.forEach((job) => jobs.set(job.id, job));
    const overlay = document.createElement("div");
    overlay.className = "dl-list";
    overlay.innerHTML = `
      <div class="dl-list__box">
        <div class="dl-list__title"></div>
        <div class="dl-list__items"></div>
        <div class="dl-list__buttons">
          <button data-act="folder"></button>
          <button data-act="close"></button>
        </div>
      </div>`;
    const q = (selector) => overlay.querySelector(selector);
    q(".dl-list__title").textContent = t("app_downloads_title");
    q('[data-act="folder"]').textContent = t("app_downloads_folder");
    q('[data-act="close"]').textContent = t("app_downloads_close");
    const items = q(".dl-list__items");

    render = () => {
      items.textContent = "";
      const all = [...jobs.values()].sort((a, b) => b.id - a.id);
      if (!all.length) {
        const empty = document.createElement("div");
        empty.className = "dl-list__empty";
        empty.textContent = t("app_downloads_empty");
        items.appendChild(empty);
      }
      for (const job of all) {
        const row = document.createElement("div");
        row.className = "dl-item";
        const name = document.createElement("div");
        name.className = "dl-item__name";
        name.textContent = job.title;
        const info = document.createElement("div");
        info.className = "dl-item__info";
        info.textContent = describe(job);
        row.append(name, info);
        if (["active", "queued"].includes(job.status)) {
          const bar = document.createElement("div");
          bar.className = "dl-item__bar";
          const fill = document.createElement("div");
          fill.className = "dl-item__fill";
          fill.style.width =
            job.progress === null ? "0" : Math.round(job.progress * 100) + "%";
          bar.appendChild(fill);
          row.appendChild(bar);
        }
        const buttons = document.createElement("div");
        buttons.className = "dl-item__buttons";
        if (["active", "queued"].includes(job.status))
          buttons.appendChild(button("cancel", job.id, "app_downloads_cancel"));
        if (["error", "canceled"].includes(job.status))
          buttons.appendChild(button("retry", job.id, "app_downloads_retry"));
        if (job.file)
          buttons.appendChild(button("reveal", job.id, "app_downloads_show"));
        if (["done", "error", "canceled"].includes(job.status))
          buttons.appendChild(button("remove", job.id, "app_downloads_remove"));
        row.appendChild(buttons);
        items.appendChild(row);
      }
    };
    render();

    const close = () => {
      window.removeEventListener("keydown", onKey, true);
      render = null;
      overlay.remove();
    };
    // Keep Lampa's global key handlers away from the list; Esc closes it.
    function onKey(event) {
      if (event.key !== "Escape") return;
      event.stopImmediatePropagation();
      close();
    }
    window.addEventListener("keydown", onKey, true);
    overlay.addEventListener("click", async (event) => {
      if (event.target === overlay) return close();
      const act = event.target?.dataset?.act;
      const id = Number(event.target?.dataset?.id);
      if (act === "close") return close();
      if (act === "folder") return void api.openFolder();
      if (act === "cancel") await api.cancel(id);
      if (act === "retry") await api.retry(id);
      if (act === "reveal") return void api.reveal(id);
      if (act === "remove") {
        await api.remove(id);
        jobs.delete(id);
      }
      render?.();
    });
    document.body.appendChild(overlay);
  }

  // A live row with the film being downloaded and its percentage.
  let statusRow = null;
  // The download shown in the row: the latest running one, else the last one.
  function currentJob() {
    const all = [...jobs.values()].sort((a, b) => b.id - a.id);
    // A canceled download leaves the row empty rather than keeping its percent.
    return (
      all.find((item) => ["active", "queued"].includes(item.status)) ||
      all.find((item) => item.status !== "canceled")
    );
  }
  async function cancelCurrent() {
    const job = currentJob();
    if (!job || !["active", "queued"].includes(job.status))
      return toast(t("app_downloads_nothing"));
    const ok = await api.cancel(job.id).catch(() => false);
    // Do not wait for the update event: clear the percent right away.
    if (ok)
      jobs.set(job.id, {
        ...job,
        status: "canceled",
        progress: null,
        speed: 0,
      });
    updateStatusRow();
    updateBadge();
    toast(
      (ok ? t("app_downloads_canceled_note") : t("app_downloads_failed")) +
        job.title,
    );
  }
  function updateStatusRow() {
    if (!statusRow) return;
    const job = currentJob();
    const name = statusRow.find(".settings-param__name");
    const descr = statusRow.find(".settings-param__descr");
    if (!job) {
      name.text(t("app_downloads_status"));
      return descr.text(t("app_downloads_empty"));
    }
    const percent =
      job.status === "done"
        ? "✓"
        : job.status === "error"
          ? "✗"
          : job.progress === null
            ? "…"
            : Math.round(job.progress * 100) + "%";
    name.text(`${job.title} — ${percent}`);
    descr.text(describe(job));
  }
  // The mpv settings are registered once mpv's availability is known (in
  // mpvTube.js); register after them so they stay first on the page.
  function registerSettings() {
    Lampa.SettingsApi.addParam({
      component: SETTINGS_COMPONENT,
      param: { name: STATUS_ROW, type: "static" },
      field: { name: t("app_downloads_status"), description: "" },
      onRender: (element) => {
        statusRow = element;
        updateStatusRow();
      },
    });
    Lampa.SettingsApi.addParam({
      component: SETTINGS_COMPONENT,
      param: { name: CANCEL_BUTTON, type: "button" },
      field: {
        name: t("app_downloads_cancel_current"),
        description: t("app_downloads_cancel_current_descr"),
      },
      onChange: () => void cancelCurrent(),
    });
    Lampa.SettingsApi.addParam({
      component: SETTINGS_COMPONENT,
      param: {
        name: TOOL_SETTING,
        type: "select",
        values: {
          auto: t("app_downloads_tool_auto"),
          "yt-dlp": "yt-dlp",
          curl: "curl",
        },
        default: "auto",
      },
      field: {
        name: t("app_downloads_tool"),
        description: t("app_downloads_tool_descr"),
      },
    });
    Lampa.SettingsApi.addParam({
      component: SETTINGS_COMPONENT,
      param: { name: LIST_BUTTON, type: "button" },
      field: {
        name: t("app_downloads_title"),
        description: t("app_downloads_descr"),
      },
      onChange: () => void openList(),
    });
  }
  Promise.resolve(window.electronAPI?.mpv?.available?.())
    .catch(() => false)
    .then(() => setTimeout(registerSettings, 0));
})();
