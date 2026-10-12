// Common opening screen for the original HTML5 player and built-in mpv.
(function () {
  const Lampa = window.Lampa;
  if (!Lampa?.Player?.listener || window.desktopPlaybackCover) return;
  let state = null;
  let timer = null;
  let request = null;
  let generation = 0;
  let mainCard = null;
  const fullCards = new Map();
  const api = window.electronAPI?.mpv;

  function speed(bytes) {
    return Number.isFinite(bytes) && bytes >= 0
      ? ((bytes * 8) / 1000000).toFixed(2) + " Мбит/с"
      : "—";
  }
  function cardKey(card) {
    if (card?.id === undefined || card?.id === null) return null;
    const type =
      card.first_air_date || (card.name && !card.title) ? "tv" : "movie";
    return type + ":" + card.id;
  }
  function captureFullCard(card, body) {
    if (!card) return;
    const root = body?.get?.(0) || body?.[0] || body;
    const image = root?.querySelector?.(".full-start__background");
    const snapshot = { ...card };
    const visibleImage = image?.currentSrc || image?.src;
    if (visibleImage) snapshot.desktopBackdrop = visibleImage;
    mainCard = snapshot;
    const key = cardKey(card);
    if (key) {
      fullCards.delete(key);
      fullCards.set(key, snapshot);
      if (fullCards.size > 20) fullCards.delete(fullCards.keys().next().value);
    }
  }
  function captureActiveFull() {
    const activity = Lampa.Activity?.active?.();
    if (activity?.component !== "full" || !activity.card) return;
    const images = Array.from(
      document.querySelectorAll(".full-start__background"),
    );
    const visible = images.find((image) => {
      const rect = image.getBoundingClientRect();
      const style = getComputedStyle(image);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden"
      );
    });
    captureFullCard(activity.card, { querySelector: () => visible });
  }
  function rememberCard(data = {}) {
    captureActiveFull();
    const activity = Lampa.Activity?.active?.();
    const candidates = [activity?.card, data.card, data.movie].filter(Boolean);
    const cached = candidates
      .map(cardKey)
      .map((key) => fullCards.get(key))
      .find(Boolean);
    if (cached) {
      mainCard = cached;
      return;
    }
    const identified = candidates.find((card) => cardKey(card));
    // Tracks and online plugins may supply file thumbnails, not the full-card art.
    if (mainCard && (!identified || cardKey(identified) === cardKey(mainCard)))
      return;
    const card = identified || candidates[0];
    if (card) mainCard = { ...card };
  }
  function poster(data) {
    if (!mainCard) rememberCard(data);
    const card = mainCard || {};
    let image =
      card.desktopBackdrop ||
      card.backdrop_path ||
      card.background_image ||
      card.poster_path ||
      card.img ||
      card.poster;
    if (
      image &&
      !/^(https?:)?\/\//i.test(image) &&
      !/^(data|blob):/i.test(image)
    ) {
      try {
        image = Lampa.Api.img(image, "w1280");
      } catch {
        image = "";
      }
    }
    return {
      image: image || data.img || data.thumbnail || "",
      title:
        card.title ||
        card.name ||
        data.first_title ||
        data.title ||
        "Открываем видео",
    };
  }
  function hide() {
    generation++;
    clearInterval(timer);
    timer = null;
    request?.clear?.();
    request = null;
    state?.node.remove();
    state = null;
  }
  function renderStats(bytes, peers) {
    if (!state) return;
    state.stats.textContent = "Скорость: " + speed(bytes);
    if (state.data.torrent_hash) {
      const active = Number.isFinite(peers?.active_peers)
        ? peers.active_peers
        : "—";
      const total = Number.isFinite(peers?.total_peers)
        ? peers.total_peers
        : "—";
      state.stats.textContent += " · Пиры: " + active + "/" + total;
    }
  }
  async function update() {
    const current = state;
    if (!current || current.busy) return;
    current.busy = true;
    const id = generation;
    try {
      if (current.data.torrent_hash && Lampa.Torserver?.url && Lampa.Reguest) {
        request ||= new Lampa.Reguest();
        request.timeout(2500);
        const stats = await new Promise((resolve) => {
          request.silent(
            Lampa.Torserver.url() + "/torrents",
            resolve,
            () => resolve(null),
            JSON.stringify({ action: "get", hash: current.data.torrent_hash }),
          );
        });
        if (state === current && generation === id)
          renderStats(stats?.download_speed, stats);
      } else if (current.mpv && api) {
        const stats = await api.get("demuxer-cache-state");
        if (state === current && generation === id)
          renderStats(stats?.["raw-input-rate"]);
      } else {
        // Cross-origin servers may withhold timing sizes; never invent a rate.
        const entries = performance
          .getEntriesByType("resource")
          .filter(
            (entry) =>
              entry.startTime >= current.started &&
              /\.(ts|m4s|aac|mp4)(?:[?:]|$)/i.test(entry.name) &&
              entry.responseEnd > 0,
          );
        const bytes = entries.reduce(
          (sum, entry) => sum + (entry.transferSize || 0),
          0,
        );
        const elapsed = (performance.now() - current.started) / 1000;
        renderStats(bytes > 0 && elapsed > 0 ? bytes / elapsed : undefined);
      }
    } catch {
      if (state === current) renderStats(undefined);
    } finally {
      current.busy = false;
    }
  }
  function show(data = {}, options = {}) {
    if (state?.data === data) {
      state.mpv = options.mpv || state.mpv;
      return;
    }
    hide();
    const content = poster(data);
    const node = document.createElement("div");
    node.className = "desktop-playback-cover";
    const panel = document.createElement("div");
    panel.className = "desktop-playback-cover__panel";
    if (content.image) {
      const background = document.createElement("img");
      background.className = "desktop-playback-cover__background";
      background.src = content.image;
      background.alt = "";
      node.appendChild(background);
      const image = document.createElement("img");
      image.className = "desktop-playback-cover__poster";
      image.src = content.image;
      image.alt = content.title;
      node.appendChild(image);
    }
    const info = document.createElement("div");
    const title = document.createElement("div");
    title.className = "desktop-playback-cover__title";
    title.textContent = content.title;
    const loading = document.createElement("div");
    loading.className = "desktop-playback-cover__loading";
    loading.textContent = "Открываем видео…";
    const stats = document.createElement("div");
    stats.className = "desktop-playback-cover__stats";
    info.appendChild(title);
    info.appendChild(loading);
    info.appendChild(stats);
    panel.appendChild(info);
    node.appendChild(panel);
    node.addEventListener("click", () => {
      hide();
      Lampa.Player.close?.();
    });
    document.body.appendChild(node);
    state = {
      data,
      node,
      stats,
      mpv: Boolean(options.mpv),
      started: performance.now(),
      busy: false,
    };
    renderStats(undefined);
    timer = setInterval(() => void update(), 1000);
    void update();
  }
  const style = document.createElement("style");
  style.textContent = `
    .desktop-playback-cover { position:fixed; inset:0; z-index:60; overflow:hidden;
      background:#0b0d12; color:#fff; }
    .desktop-playback-cover img { position:absolute; inset:0; width:100%; height:100%; }
    .desktop-playback-cover__background { object-fit:cover; filter:blur(24px);
      opacity:.35; transform:scale(1.08); }
    .desktop-playback-cover__poster { object-fit:cover; }
    .desktop-playback-cover::after { content:""; position:absolute; inset:0;
      background:linear-gradient(transparent 25%,rgba(0,0,0,.25) 50%,rgba(0,0,0,.9));
      pointer-events:none; }
    .desktop-playback-cover__panel { position:absolute; left:5%; right:5%; bottom:6%;
      z-index:1; text-shadow:0 2px 8px rgba(0,0,0,.8); }
    .desktop-playback-cover__panel > div { min-width:0; }
    .desktop-playback-cover__title { overflow-wrap:anywhere; font-size:2em; font-weight:600; margin-bottom:.6em; }
    .desktop-playback-cover__loading { opacity:.8; margin-bottom:1em; }
    .desktop-playback-cover__loading::before { content:""; display:inline-block;
      width:1em; height:1em; margin-right:.6em; vertical-align:-.15em;
      border:2px solid #555; border-top-color:#fff; border-radius:50%;
      animation:desktop-playback-spin .8s linear infinite; }
    .desktop-playback-cover__stats { font-variant-numeric:tabular-nums; opacity:.7; }
    @keyframes desktop-playback-spin { to { transform:rotate(360deg); } }
  `;
  document.head.appendChild(style);
  window.desktopPlaybackCover = { show, hide };
  Lampa.Listener?.follow("full", (event) => {
    if (event.type !== "start" && event.type !== "complite") return;
    captureFullCard(event.data?.movie || event.object?.card, event.body);
  });
  const originalActivityPush = Lampa.Activity?.push;
  if (typeof originalActivityPush === "function") {
    Lampa.Activity.push = function () {
      captureActiveFull();
      return originalActivityPush.apply(this, arguments);
    };
  }
  captureActiveFull();
  Lampa.Player.listener.follow("create", (event) => rememberCard(event.data));
  Lampa.Player.listener.follow("start", (data) => {
    if (!mainCard) rememberCard(data);
    show(data);
  });
  Lampa.Player.listener.follow("destroy", hide);
  Lampa.Player.listener.follow("external", hide);
  Lampa.PlayerVideo.listener.follow("loadeddata", () => {
    const video = Lampa.PlayerVideo.video?.();
    if (video?.tagName !== "VIDEO") return;
    const opening = state;
    if (video.requestVideoFrameCallback)
      video.requestVideoFrameCallback(() => {
        if (state === opening && opening && !opening.mpv) hide();
      });
    else if (!state?.mpv) hide();
  });
  Lampa.PlayerVideo.listener.follow("error", hide);
  api?.onEvent((event) => {
    if (state?.mpv && event.event === "playback-restart") hide();
    if (state?.mpv && event.event === "end-file" && event.reason === 4) hide();
  });
})();
