// Built-in mpv player for Lampa (macOS).
// Registers a Lampa "tube": a video-like object that mirrors the parts of
// HTMLVideoElement Lampa's PlayerVideo uses, but plays through libmpv, which is
// drawn in a native view behind this (transparent) page.
(function () {
  const api = window.electronAPI?.mpv;
  const Lampa = window.Lampa;
  if (!api || !Lampa?.PlayerVideo?.registerTube || window.desktopMpvInstalled)
    return;
  window.desktopMpvInstalled = true;

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
  // The native addon exists only on macOS builds that bundled it.
  api
    .available()
    .then((ok) => ok && install())
    .catch(() => {});

  function install() {
    ensureSettingsComponent();
    const ONLINE_SETTING = "mpv_online_enabled";
    const BUFFER_SETTING = "mpv_buffer_secs";
    const CONFIG_BUTTON = "mpv_config_edit";
    // The buffer lives in RAM (mpv's demuxer cache, no disk cache). Its size is
    // limited both by time and by bytes, whichever is reached first.
    const BUFFER_DEFAULT = 60;
    const BUFFER_MAX_BYTES = "512MiB";
    const CLASS = "mpv-active";
    let active = null; // the shim instance currently owning mpv
    let need = "player"; // which Lampa player setting applies to the current play
    let playData = null; // what Lampa was asked to play (for the poster)

    // Lampa asks the tubes before it considers external players, but without
    // telling which player type applies. Remember it from the play call.
    for (const [method, key] of [
      ["play", null],
      ["iptv", "player_iptv"],
    ]) {
      const original = Lampa.Player[method];
      if (typeof original !== "function") continue;
      Lampa.Player[method] = function (data) {
        need = key || (data && data.torrent_hash ? "player_torrent" : "player");
        playData = data || null;
        return original.apply(this, arguments);
      };
    }

    // MPV is a separate external player; only Inner uses the native view.
    function replacesChoice(type) {
      return type === "inner";
    }

    // The external «MPV» entry is hidden from every player list; the built-in
    // mpv is reached through «Встроенный» (labelled «MPV» for torrents).
    for (const key of ["player", "player_iptv", "player_torrent"]) {
      const choices = Lampa.Params?.values?.[key];
      if (!choices || !Lampa.Params?.select) continue;
      const rest = Object.fromEntries(
        Object.entries(choices).filter(([id]) => id !== "mpv"),
      );
      if (key === "player_torrent") rest.inner = "Встроенный (MPV)";
      Lampa.Params.select(key, rest, "inner");
      if (Lampa.Storage.get(key) === "mpv") Lampa.Storage.set(key, "inner");
    }

    function onlineMpvEnabled() {
      const value = Lampa.Storage.get(ONLINE_SETTING, false);
      return value === true || value === "true";
    }

    function bufferSecs() {
      const value = Number(Lampa.Storage.get(BUFFER_SETTING, BUFFER_DEFAULT));
      return Number.isFinite(value) && value >= 5 && value <= 600
        ? Math.round(value)
        : BUFFER_DEFAULT;
    }

    // Set while the HTML5 player is being swapped for mpv (see the AC3 watcher).
    let forceMpv = false;
    let resumeAt = null;

    function enabled() {
      return (
        forceMpv ||
        ((need === "player_torrent" || onlineMpvEnabled()) &&
          replacesChoice(Lampa.Storage.field(need)))
      );
    }

    // The video is drawn behind the web view. Lampa normally hides everything
    // below the player with its opaque player layer; we made that layer
    // transparent, so windows and backdrops that live under the player (a
    // torrent list modal, a plugin's blurred poster) would show over the
    // video. Hide every large full-screen element that sits at or below the
    // player's z-index, and restore them afterwards. Dialogs, loaders and
    // notifications stack above the player and are left alone.
    const PLAYER_Z = 50;
    const hiddenBackdrops = new Map();
    let sweepTimer = null;

    function sweepBackdrops() {
      const player = document.querySelector(".player");
      if (!player) return;
      const inspect = (el) => {
        if (el === player || hiddenBackdrops.has(el)) return;
        // Keep the player and every ancestor that contains it visible.
        if (el.contains(player)) {
          Array.from(el.children).forEach(inspect);
          return;
        }
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return;
        const z = parseInt(style.zIndex, 10);
        if ((Number.isNaN(z) ? 0 : z) > PLAYER_Z) return;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        hiddenBackdrops.set(el, {
          value: el.style.getPropertyValue("visibility"),
          priority: el.style.getPropertyPriority("visibility"),
        });
        el.style.setProperty("visibility", "hidden", "important");
        el.classList.add("mpv-underlay-hidden");
      };
      Array.from(document.body.children).forEach(inspect);
    }

    function startBackdropSweep() {
      sweepBackdrops();
      if (!sweepTimer) sweepTimer = setInterval(sweepBackdrops, 1000);
    }

    function stopBackdropSweep() {
      clearInterval(sweepTimer);
      sweepTimer = null;
      hiddenBackdrops.forEach((original, el) => {
        el.classList.remove("mpv-underlay-hidden");
        el.style.removeProperty("visibility");
        if (original.value)
          el.style.setProperty("visibility", original.value, original.priority);
      });
      hiddenBackdrops.clear();
    }

    function showCover() {
      window.desktopPlaybackCover?.show(playData || {}, { mpv: true });
    }
    function hideCover() {
      window.desktopPlaybackCover?.hide();
    }

    function addStyle() {
      if (document.getElementById("mpv-builtin-style")) return;
      const style = document.createElement("style");
      style.id = "mpv-builtin-style";
      style.textContent = `
      html.${CLASS}, html.${CLASS} body, html.${CLASS} .player,
      html.${CLASS} .player-video, html.${CLASS} .player-video__display {
        background: transparent !important;
      }
      /* Lampa covers its UI with the opaque player; we made that transparent. */
      html.${CLASS} #app { visibility: hidden !important; }
      html.${CLASS} .mpv-underlay-hidden,
      html.${CLASS} .mpv-underlay-hidden * { visibility: hidden !important; }
      .mpv-cover {
        position: fixed; inset: 0; z-index: 60; overflow: hidden;
        background: #1d1f20; opacity: 1; transition: opacity 0.3s ease;
        display: flex; align-items: center; justify-content: center;
      }
      .mpv-cover--leaving { opacity: 0; pointer-events: none; }
      .mpv-cover img {
        position: absolute; inset: 0; width: 100%; height: 100%;
        object-fit: cover; opacity: 0.58;
      }
      .mpv-cover::after {
        content: ""; position: absolute; inset: 0;
        background: linear-gradient(rgba(4,4,8,.3), rgba(4,4,8,.58) 60%, rgba(4,4,8,.82));
      }
      .mpv-cover__box {
        position: relative; z-index: 1; text-align: center; color: #fff;
        text-shadow: 0 0 0.3em rgba(0,0,0,.6); max-width: 70%;
      }
      .mpv-cover__title { font-size: 2.4em; font-weight: 600; margin-bottom: 1.2em; }
      .mpv-cover__spinner {
        width: 2.6em; height: 2.6em; margin: 0 auto;
        border: 0.25em solid rgba(255,255,255,.25); border-top-color: #fff;
        border-radius: 50%; animation: mpv-cover-spin 0.9s linear infinite;
      }
      @keyframes mpv-cover-spin { to { transform: rotate(360deg); } }
      .player-info__values .value--mpv span {
        padding: 0.1em 0.5em;
        background: rgba(255, 255, 255, 0.1);
        border-radius: 1em;
      }`;
      document.head.appendChild(style);
    }

    // A small "mpv" pill next to Lampa's resolution pill, so it is visible
    // which player is actually in use.
    function showBadge(text) {
      const size = document.querySelector(".player-info__values .value--size");
      if (!size) return;
      let badge = document.querySelector(".player-info__values .value--mpv");
      if (!badge) {
        badge = document.createElement("div");
        badge.className = "value--mpv";
        badge.appendChild(document.createElement("span"));
        size.after(badge);
      }
      badge.firstChild.textContent = text;
    }

    function removeBadge() {
      document
        .querySelectorAll(".player-info__values .value--mpv")
        .forEach((node) => node.remove());
    }

    async function updateBadge() {
      let decoder = "";
      try {
        decoder = String((await api.get("hwdec-current")) || "");
      } catch {
        // The badge still shows "mpv" without decoder details.
      }
      const hardware = decoder && decoder !== "no";
      showBadge(
        decoder ? "mpv · " + (hardware ? "VideoToolbox" : "software") : "mpv",
      );
    }

    function createShim() {
      const playback = Lampa.Player.playdata?.() || playData || {};
      // Position handed over from the HTML5 player after an AC3 fallback.
      let handover = resumeAt;
      resumeAt = null;
      const el = document.createElement("div");
      el.className = "player-video__video";
      el.style.background = "transparent";
      const listeners = {};
      const state = {
        src: "",
        time: 0,
        duration: 0,
        paused: true,
        loaded: false,
        width: 0,
        height: 0,
        volume: 1,
        muted: false,
        rate: 1,
        error: null,
        pendingSeek: null,
        openingStart: 0,
        seekTarget: null,
        metadataSent: false,
        hasPlayback: false,
        recordingAllowed: false,
        destroyed: false,
        audio: [],
        subs: [],
        lastTimeEvent: 0,
        pendingSubOff: null,
      };

      el.addEventListener = (name, fn) => {
        (listeners[name] = listeners[name] || []).push(fn);
      };
      el.removeEventListener = (name, fn) => {
        listeners[name] = (listeners[name] || []).filter((f) => f !== fn);
      };
      const emit = (type, extra) => {
        const event = Object.assign({ type }, extra);
        (listeners[type] || []).slice().forEach((fn) => {
          try {
            fn(event);
          } catch (error) {
            console.error("mpv shim listener", type, error);
          }
        });
      };

      const define = (name, get, set) =>
        Object.defineProperty(el, name, {
          configurable: true,
          get,
          set: set || (() => {}),
        });
      define(
        "src",
        () => state.src,
        (v) => (state.src = String(v || "")),
      );
      define("currentSrc", () => state.src);
      define(
        "currentTime",
        () => state.time,
        (v) => {
          const t = Math.max(0, Number(v) || 0);
          state.time = t;
          state.seekTarget = t;
          if (!state.loaded) state.pendingSeek = t;
          else api.command(["seek", String(t), "absolute+exact"]);
        },
      );
      define("duration", () => state.duration);
      define("paused", () => state.paused);
      define("videoWidth", () => state.width);
      define("videoHeight", () => state.height);
      define("error", () => state.error);
      define("buffered", () => ({ length: 0 }));
      define(
        "volume",
        () => state.volume,
        (v) => {
          state.volume = Math.min(1, Math.max(0, Number(v) || 0));
          if (state.loaded) api.set("volume", Math.round(state.volume * 100));
        },
      );
      define(
        "muted",
        () => state.muted,
        (v) => {
          state.muted = Boolean(v);
          if (state.loaded) api.set("mute", state.muted ? "yes" : "no");
        },
      );
      define(
        "playbackRate",
        () => state.rate,
        (v) => {
          state.rate = Number(v) || 1;
          api.set("speed", state.rate);
        },
      );
      define("audioTracks", () => state.audio);
      define("textTracks", () => state.subs);

      el.canPlayType = () => "maybe";
      el.speed = (v) => (el.playbackRate = v);

      function initialPosition() {
        if (handover !== null) {
          const position = handover;
          handover = null;
          return position;
        }
        if (state.pendingSeek !== null) return state.pendingSeek;
        const timeline = playback.timeline;
        const policy = Lampa.Storage.field("player_timecode");
        if (
          !timeline ||
          policy === "again" ||
          timeline.waiting_for_user ||
          timeline.stop_recording ||
          timeline.continued_bloc ||
          (policy === "ask" && Number(timeline.percent) > 0) ||
          Number(timeline.percent) >= 90
        )
          return 0;
        const duration = Number(timeline.duration);
        let position = Number(timeline.time);
        if ((!Number.isFinite(position) || position <= 0) && duration > 0)
          position = (duration * Number(timeline.percent)) / 100;
        if (!Number.isFinite(position) || position <= 10) return 0;
        return duration > 15 ? Math.min(position, duration - 15) : position;
      }

      function publishPosition() {
        state.recordingAllowed =
          !playback.timeline?.stop_recording &&
          !playback.timeline?.waiting_for_user;
        if (!state.loaded || !state.metadataSent || state.duration <= 0) return;
        if (state.seekTarget !== null) {
          if (Math.abs(state.time - state.seekTarget) > 2) return;
          state.seekTarget = null;
          if (state.openingStart > 0 && playback.timeline)
            playback.timeline.continued = true;
        }
        emit("timeupdate");
      }

      function announceLoaded(firstFrame = false) {
        if (
          !state.loaded ||
          state.metadataSent ||
          (!firstFrame && state.duration <= 0)
        )
          return;
        state.metadataSent = true;
        emit("loadedmetadata");
        emit("durationchange");
        emit("loadeddata");
        emit("canplay");
        publishPosition();
      }

      function captureFinalPosition() {
        const timeline = playback.timeline;
        const save =
          state.hasPlayback &&
          state.recordingAllowed &&
          timeline &&
          !timeline.waiting_for_user &&
          !timeline.stop_recording &&
          state.seekTarget === null &&
          typeof timeline.handler === "function";
        if (!save) return;
        const cached = { time: state.time, duration: state.duration };
        const persist = async (time, duration) => {
          if (
            !Number.isFinite(duration) ||
            duration <= 0 ||
            !Number.isFinite(time) ||
            time < 0
          )
            return;
          time = Math.min(time, duration);
          const percent = Math.round((time / duration) * 100);
          timeline.time = time;
          timeline.duration = duration;
          timeline.percent = percent;
          await timeline.handler(percent, time, duration);
          console.info("[mpv timeline] saved", { time, duration, percent });
        };
        // Queue reads before stop; retain this episode's handler across teardown.
        Promise.all([api.get("time-pos"), api.get("duration")])
          .catch((error) => {
            console.warn("[mpv timeline] final position:", error);
            return [cached.time, cached.duration];
          })
          .then(([time, duration]) =>
            persist(
              typeof time === "number" ? time : cached.time,
              typeof duration === "number" ? duration : cached.duration,
            ),
          )
          .catch((error) => console.warn("[mpv timeline] save failed:", error));
      }

      el.load = () => {
        if (!state.src) return;
        document.documentElement.classList.add(CLASS);
        startBackdropSweep();
        showCover();
        state.loaded = false;
        state.error = null;
        state.metadataSent = false;
        state.hasPlayback = false;
        state.openingStart = initialPosition();
        state.seekTarget = state.openingStart > 0 ? state.openingStart : null;
        console.info("[mpv timeline] opening", {
          start: state.openingStart,
          policy: Lampa.Storage.field("player_timecode"),
        });
        api
          .open(state.src, {
            start: state.openingStart,
            volume: Math.round(state.volume * 100),
            mpvOptions: {
              sid: "no",
              "demuxer-readahead-secs": bufferSecs(),
              "demuxer-max-bytes": BUFFER_MAX_BYTES,
            },
          })
          .then((result) => {
            if (result && result.ok) return;
            fail(result?.error || "open failed");
          })
          .catch((error) => fail(String(error)));
      };
      el.play = () => {
        api.set("pause", "no");
        return Promise.resolve();
      };
      el.pause = () => {
        api.set("pause", "yes");
      };
      el.destroy = () => {
        if (state.destroyed) return;
        state.destroyed = true;
        captureFinalPosition();
        if (active === el) active = null;
        document.documentElement.classList.remove(CLASS);
        stopBackdropSweep();
        removeBadge();
        hideCover();
        api.stop();
        Object.keys(listeners).forEach((k) => delete listeners[k]);
      };

      function fail(message) {
        hideCover();
        state.error = { code: 4, message };
        emit("error");
      }

      function buildTracks(list) {
        const audio = [];
        const subs = [];
        (Array.isArray(list) ? list : []).forEach((t) => {
          if (t.type === "audio") {
            const item = {
              index: t.id,
              language: t.lang || "",
              label: t.title || "",
              extra: {
                channels: t["demux-channel-count"],
                fourCC: t.codec,
              },
              selected: Boolean(t.selected),
            };
            Object.defineProperty(item, "enabled", {
              enumerable: true,
              get: () => item.selected,
              set: (v) => {
                if (v) api.set("aid", t.id);
              },
            });
            audio.push(item);
          } else if (t.type === "sub") {
            const item = {
              index: t.id,
              language: t.lang || "",
              label: t.title || t.codec || "",
              extra: { codec: t.codec },
              selected: Boolean(t.selected),
            };
            Object.defineProperty(item, "mode", {
              enumerable: true,
              get: () => (item.selected ? "showing" : "disabled"),
              set: (v) => {
                if (v === "showing") {
                  clearTimeout(state.pendingSubOff);
                  api.set("sid", t.id);
                } else {
                  // Lampa disables every track, then enables the chosen one.
                  // If nothing is enabled afterwards, turn subtitles off.
                  clearTimeout(state.pendingSubOff);
                  state.pendingSubOff = setTimeout(
                    () => api.set("sid", "no"),
                    0,
                  );
                }
              },
            });
            subs.push(item);
          }
        });
        state.audio = audio;
        state.subs = subs;
      }

      el.__mpvEvent = (ev) => {
        if (ev.event === "property-change") {
          const { name, data } = ev;
          if (name === "time-pos" && typeof data === "number") {
            state.time = data;
            const now = Date.now();
            if (now - state.lastTimeEvent >= 250) {
              state.lastTimeEvent = now;
              publishPosition();
            }
          } else if (name === "duration" && typeof data === "number") {
            state.duration = data;
            announceLoaded();
          } else if (name === "pause") {
            state.paused = Boolean(data);
          } else if (name === "paused-for-cache") {
            emit(data ? "waiting" : "playing");
          } else if (name === "hwdec-current") {
            void updateBadge();
          } else if (name === "video-params" && data) {
            state.width = data.w || 0;
            state.height = data.h || 0;
          } else if (name === "demuxer-cache-time" && state.duration > 0) {
            const percent = Math.min(
              100,
              (Number(data) / state.duration) * 100,
            );
            emit("progress", { percent: Math.round(percent) });
          } else if (name === "track-list") {
            buildTracks(data);
          } else if (name === "eof-reached" && data === true) {
            emit("ended");
          }
        } else if (ev.event === "playback-restart") {
          // First picture is on screen: metadata and time are now usable.
          state.hasPlayback = true;
          announceLoaded(true);
          publishPosition();
          emit("playing");
          hideCover();
        } else if (ev.event === "file-loaded") {
          state.loaded = true;
          api.set("mute", state.muted ? "yes" : "no");
          if (
            state.pendingSeek !== null &&
            state.pendingSeek !== state.openingStart
          ) {
            api.command(["seek", String(state.pendingSeek), "absolute+exact"]);
          }
          state.pendingSeek = null;
          announceLoaded();
          showBadge("mpv");
          void updateBadge();
          // The decoder is only known once the first frames are decoded.
          setTimeout(updateBadge, 1500);
        } else if (ev.event === "end-file" && ev.reason === 4) {
          fail(ev.error || "playback error");
        }
      };
      return el;
    }

    api.onEvent((ev) => active?.__mpvEvent(ev));

    // The HTML5 player (Chromium) cannot decode AC3/EAC3: the video plays in
    // silence, or an HLS stream fails outright. When that happens, reopen the
    // same stream in mpv at the same position, inside the running player.
    const switched = new Set();

    // Editor for the user's mpv.conf. Plain overlay with a textarea: Lampa's own
    // key handling would otherwise swallow typing and pasting.
    async function openConfigEditor() {
      const info = await api.getConfig().catch(() => null);
      if (!info || document.querySelector(".mpv-conf")) return;
      if (!document.getElementById("mpv-conf-style")) {
        const style = document.createElement("style");
        style.id = "mpv-conf-style";
        style.textContent = `
          .mpv-conf { position: fixed; inset: 0; z-index: 120; display: flex;
            align-items: center; justify-content: center;
            background: rgba(0, 0, 0, 0.75); color: #fff; }
          .mpv-conf__box { width: min(90%, 52em); max-height: 90%; display: flex;
            flex-direction: column; gap: 0.8em; padding: 1.6em; border-radius: 1em;
            background: rgba(30, 30, 30, 0.95); }
          .mpv-conf__title { font-size: 1.5em; }
          .mpv-conf__hint, .mpv-conf__msg { font-size: 0.9em; opacity: 0.7; white-space: pre-wrap;
            line-height: 1.4; word-break: break-word; }
          .mpv-conf__msg { white-space: pre-wrap; min-height: 1.4em; }
          .mpv-conf__text { height: 20em; resize: none; padding: 0.8em;
            border: 0; border-radius: 0.6em; background: rgba(255, 255, 255, 0.1);
            color: #fff; font: 0.95em/1.4 ui-monospace, Menlo, monospace; }
          .mpv-conf__row { display: flex; gap: 0.8em; align-items: center; }
          .mpv-conf__row select, .mpv-conf__row input { flex: 1; min-width: 0; padding: 0.6em 0.8em;
            border: 0; border-radius: 0.6em; background: rgba(255, 255, 255, 0.1);
            color: #fff; font-size: 1em; }
          .mpv-conf__row option { color: #000; }
          .mpv-conf__buttons { display: flex; gap: 0.8em; justify-content: flex-end; }
          .mpv-conf__buttons button, .mpv-conf__row button { padding: 0.6em 1.4em; border: 0; border-radius: 0.6em;
            background: rgba(255, 255, 255, 0.15); color: #fff; font-size: 1em; cursor: pointer; }
          .mpv-conf__buttons button:hover, .mpv-conf__buttons button:focus,
          .mpv-conf__row button:hover, .mpv-conf__row button:focus {
            background: rgba(255, 255, 255, 0.3); outline: 0; }`;
        document.head.appendChild(style);
      }
      const overlay = document.createElement("div");
      overlay.className = "mpv-conf";
      overlay.innerHTML = `
        <div class="mpv-conf__box">
          <div class="mpv-conf__title"></div>
          <div class="mpv-conf__hint"></div>
          <div class="mpv-conf__row">
            <select class="mpv-conf__target"></select>
            <button data-act="delete"></button>
          </div>
          <textarea class="mpv-conf__text" spellcheck="false" autocapitalize="off"
            autocomplete="off" placeholder="# hwdec=videotoolbox&#10;# demuxer-max-bytes=1GiB"></textarea>
          <div class="mpv-conf__msg"></div>
          <div class="mpv-conf__row">
            <input class="mpv-conf__name" maxlength="64" spellcheck="false" autocomplete="off">
            <button data-act="saveas"></button>
          </div>
          <div class="mpv-conf__buttons">
            <button data-act="clear"></button>
            <button data-act="cancel"></button>
            <button data-act="save"></button>
          </div>
        </div>`;
      const q = (selector) => overlay.querySelector(selector);
      const t = (key) => Lampa.Lang.translate(key);
      q(".mpv-conf__title").textContent = t("app_settings_mpv_config_title");
      q(".mpv-conf__hint").textContent =
        t("app_settings_mpv_config_hint") + "\n" + info.path;
      q('[data-act="clear"]').textContent = t("app_settings_mpv_config_clear");
      q('[data-act="cancel"]').textContent = t(
        "app_settings_mpv_config_cancel",
      );
      q('[data-act="save"]').textContent = t("app_settings_mpv_config_save");
      q('[data-act="delete"]').textContent = t(
        "app_settings_mpv_profile_delete",
      );
      q('[data-act="saveas"]').textContent = t(
        "app_settings_mpv_profile_saveas",
      );
      q(".mpv-conf__name").placeholder = t("app_settings_mpv_profile_name");
      const text = q(".mpv-conf__text");
      const target = q(".mpv-conf__target");
      const msg = q(".mpv-conf__msg");
      text.value = info.text;
      let current = null; // null: the main mpv.conf; otherwise a profile name

      // Rebuilds the list of what can be edited and selects `name`.
      async function fillTargets(name) {
        const list = await api.profiles().catch(() => null);
        const names = list?.names || [];
        target.textContent = "";
        const add = (value, label) => {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = label;
          target.appendChild(option);
        };
        add("", t("app_settings_mpv_profile_main"));
        for (const item of names)
          add("p:" + item, item + (list.active === item ? " ✓" : ""));
        current = names.includes(name) ? name : null;
        target.value = current === null ? "" : "p:" + current;
        q('[data-act="delete"]').style.display = current === null ? "none" : "";
      }
      await fillTargets(null);

      target.addEventListener("change", async () => {
        const name = target.value ? target.value.slice(2) : null;
        const loaded =
          name === null
            ? (await api.getConfig().catch(() => null))?.text
            : await api.getProfile(name).catch(() => null);
        if (typeof loaded !== "string") return fillTargets(current);
        msg.textContent = "";
        text.value = loaded;
        await fillTargets(name);
        text.focus();
      });

      // Shows what mpv ignored; otherwise confirms and tells whether the
      // running player already uses the change.
      function report(result, after) {
        if (!result?.ok) {
          msg.textContent =
            t("app_settings_mpv_config_error") +
            (result?.error ? ": " + result.error : "");
          return false;
        }
        if (result.ignored?.length) {
          msg.textContent =
            t("app_settings_mpv_config_ignored") +
            "\n" +
            result.ignored
              .map((item) => `${item.line}: ${item.text} — ${item.reason}`)
              .join("\n");
          return false;
        }
        close();
        showToast(
          t(after) +
            (result.live ? "\n" + t("app_settings_mpv_applied_live") : ""),
        );
        return true;
      }

      const close = () => {
        window.removeEventListener("keydown", onKey, true);
        overlay.remove();
      };
      // Keep Lampa's global key handlers (which cancel default actions) away
      // from the editor; Esc closes it.
      function onKey(event) {
        if (!overlay.contains(event.target)) return;
        event.stopImmediatePropagation();
        if (event.key === "Escape") close();
      }
      window.addEventListener("keydown", onKey, true);

      overlay.addEventListener("click", async (event) => {
        const act = event.target?.dataset?.act;
        if (event.target === overlay || act === "cancel") return close();
        if (act === "clear") {
          text.value = "";
          text.focus();
        }
        if (act === "delete" && current !== null) {
          const result = await api.deleteProfile(current).catch(() => null);
          if (!result?.ok) return report(result);
          await fillTargets(null);
          text.value = (await api.getConfig().catch(() => null))?.text || "";
          msg.textContent = t("app_settings_mpv_profile_deleted");
          return;
        }
        if (act === "saveas") {
          const name = q(".mpv-conf__name").value.trim();
          if (!name) {
            msg.textContent = t("app_settings_mpv_profile_name");
            return;
          }
          const result = await api
            .saveProfile(name, text.value)
            .catch(() => null);
          if (!result?.ok || result.ignored?.length)
            return report(result, "app_settings_mpv_profile_saved");
          await fillTargets(name);
          q(".mpv-conf__name").value = "";
          msg.textContent = t("app_settings_mpv_profile_saved");
          return;
        }
        if (act !== "save") return;
        const result =
          current === null
            ? await api.setConfig(text.value).catch(() => null)
            : await api.saveProfile(current, text.value).catch(() => null);
        report(
          result,
          current === null
            ? "app_settings_mpv_config_saved"
            : "app_settings_mpv_profile_saved",
        );
      });
      document.body.appendChild(overlay);
      text.focus();
    }

    // Menu for switching profiles while a video plays; the choice reaches mpv
    // through the API at once, without reopening the video.
    let menuBusy = false;
    async function openProfileMenu() {
      // One menu at a time: a second one would capture «select» as the
      // controller to return to and leave the player stuck.
      if (menuBusy || Lampa.Controller.enabled?.().name === "select") return;
      menuBusy = true;
      try {
        await showProfileMenu();
      } finally {
        menuBusy = false;
      }
    }
    async function showProfileMenu() {
      const t = (key) => Lampa.Lang.translate(key);
      const info = await api.profiles().catch((error) => {
        console.error("[mpv profiles] profiles() failed:", String(error));
        return null;
      });
      if (!info) return;
      if (!info.names.length)
        return showToast(t("app_settings_mpv_profile_none"));
      const back = Lampa.Controller.enabled().name;
      const items = [
        {
          title: t("app_settings_mpv_profile_off"),
          value: null,
          selected: !info.active,
        },
        ...info.names.map((name) => ({
          title: name,
          value: name,
          selected: name === info.active,
        })),
      ];
      Lampa.Select.show({
        title: t("app_settings_mpv_profile_menu"),
        items,
        onBack: () => Lampa.Controller.toggle(back),
        onSelect: async (item) => {
          Lampa.Controller.toggle(back);
          const result = await api.applyProfile(item.value).catch(() => null);
          showToast(
            result?.ok
              ? item.value === null
                ? t("app_settings_mpv_profile_off_done")
                : t("app_settings_mpv_profile_on") + " " + item.value
              : t("app_settings_mpv_config_error"),
          );
        },
      });
    }

    // P opens the profile menu while mpv plays.
    window.addEventListener(
      "keydown",
      (event) => {
        if (
          event.code !== "KeyP" ||
          event.metaKey ||
          event.ctrlKey ||
          event.altKey
        )
          return;
        if (!active || !Lampa.Player.opened?.()) return;
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName)) return;
        // A menu is open when Lampa's select controller or the editor is.
        if (
          document.querySelector(".mpv-conf") ||
          Lampa.Controller.enabled?.().name === "select"
        )
          return;
        event.preventDefault();
        event.stopImmediatePropagation();
        openProfileMenu().catch((error) =>
          console.error(
            "[mpv profiles] menu failed:",
            String(error?.stack || error),
          ),
        );
      },
      true,
    );

    // A «Профили» button in Lampa's player panel. The panel markup belongs to
    // Lampa (served by the user's server), so look for it defensively.
    function addPanelButton() {
      const panel = document.querySelector(".player-panel");
      if (!panel || panel.querySelector(".mpv-profiles-button"))
        return Boolean(panel);
      const anchor =
        panel.querySelector(".player-panel__settings") ||
        panel.querySelector(".player-panel__playlist") ||
        panel.querySelector(".player-panel__right > *:last-child");
      const parent =
        anchor?.parentElement || panel.querySelector(".player-panel__right");
      if (!parent) return true;
      const button = document.createElement("div");
      button.className =
        "player-panel__mpvprofiles mpv-profiles-button button selector";
      button.innerHTML =
        '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor">' +
        '<path d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z"/></svg>';
      button.title = Lampa.Lang.translate("app_settings_mpv_profile_menu");
      const $button = window.$ ? window.$(button) : null;
      if ($button) $button.on("hover:enter", () => openProfileMenu());
      if (anchor) anchor.after(button);
      else parent.appendChild(button);
      return true;
    }
    // The panel is built when the player opens; retry for a few seconds.
    function watchPanel() {
      let tries = 0;
      const timer = setInterval(() => {
        if (addPanelButton() || ++tries > 20) clearInterval(timer);
      }, 250);
    }
    Lampa.Player.listener.follow("ready", watchPanel);
    Lampa.Player.listener.follow("start", watchPanel);

    // Small dark notice shared with the downloads (src/toast.js).
    function showToast(text) {
      window.desktopToast(text);
    }

    function switchToMpv(video, reason) {
      const work = Lampa.Player.playdata?.();
      if (!work || work.iptv || !Lampa.Player.opened?.()) return;
      // hls.js feeds the element a blob: URL, so reopen the original link.
      const raw = work.url || video.currentSrc || video.src;
      const src = Lampa.Torserver?.toPlayUrl?.(raw) || raw;
      // One attempt per link: never loop if mpv cannot take it either.
      if (!src || switched.has(src) || !/^(https?|file):/i.test(String(src)))
        return;
      switched.add(src);
      const position = Number.isFinite(video.currentTime)
        ? video.currentTime
        : 0;
      console.log("[mpv] AC3/EAC3 fallback:", reason, "at", position);
      forceMpv = true;
      resumeAt = position > 5 ? position : 0;
      try {
        Lampa.PlayerVideo.destroy(true);
        Lampa.PlayerVideo.url(src, true);
        Lampa.Timeline?.resetContinue?.();
        showToast("Звук AC3/EAC3: открыто во встроенном mpv");
      } finally {
        forceMpv = false;
      }
    }

    Lampa.Player.listener.follow("destroy", () => switched.clear());

    setInterval(() => {
      const video = document.querySelector("video.player-video__video");
      if (!video || video.paused) return;
      // Audio is only decoded after playback has really started.
      if (video.readyState < 3 || video.currentTime < 1.5) return;
      if (video.muted || video.volume === 0) return;
      if (video.webkitAudioDecodedByteCount === 0)
        switchToMpv(video, "no audio decoded");
    }, 1000);

    Lampa.PlayerVideo.listener.follow("error", (event) => {
      if (!event?.fatal) return;
      const video = document.querySelector("video.player-video__video");
      const work = Lampa.Player.playdata?.();
      // Leave Lampa's own reserve-link handling alone.
      if (!video || !work || work.url_reserve || work.error) return;
      const unsupported = [3, 4].includes(video.error?.code);
      if (
        unsupported ||
        /\.m3u8|\.mpd/i.test(video.currentSrc || video.src || "")
      )
        switchToMpv(video, "fatal HTML5 error");
    });

    Lampa.PlayerVideo.registerTube({
      name: "mpv",
      verify: (src) => enabled() && /^(https?|file):/i.test(String(src)),
      create: (callback) => {
        addStyle();
        const shim = createShim();
        active = shim;
        watchPanel();
        callback(shim);
        return $(shim);
      },
    });

    Lampa.Lang.add({
      app_settings_mpv_online: {
        ru: "Использовать mpv для онлайн",
        en: "Use mpv for online playback",
      },
      app_settings_mpv_buffer: {
        ru: "Буфер mpv",
        en: "mpv buffer",
      },
      app_settings_mpv_buffer_descr: {
        ru: "Сколько секунд видео mpv загружает вперёд. Буфер хранится в оперативной памяти (на диск не пишется) и не больше 512 МБ: у тяжёлых 4K-потоков он будет короче. Действует при следующем открытии видео.",
        en: "How many seconds of video mpv loads ahead. The buffer is kept in RAM (nothing is written to disk) and is capped at 512 MB, so heavy 4K streams get less. Takes effect the next time a video opens.",
      },
      app_settings_mpv_config: {
        ru: "Конфигурация mpv (mpv.conf)",
        en: "mpv configuration (mpv.conf)",
      },
      app_settings_mpv_config_descr: {
        ru: "Вставьте содержимое mpv.conf. Хранится в файле до вашего изменения. Действует со следующего видео; опции из файла важнее настроек приложения.",
        en: "Paste the contents of mpv.conf. Kept in a file until you change it. Applies to the next video; options from the file override the app's settings.",
      },
      app_settings_mpv_config_title: {
        ru: "Конфигурация mpv",
        en: "mpv configuration",
      },
      app_settings_mpv_config_hint: {
        ru: "Формат mpv.conf: опция=значение, по одной в строке; # — комментарий. Секции [профиль] и опции запуска кода игнорируются; именованные профили сохраняйте кнопкой «Сохранить как…». Файл:",
        en: "mpv.conf format: option=value, one per line; # starts a comment. [profile] sections and options that run code are ignored; save named profiles with «Save as…». File:",
      },
      app_settings_mpv_profile_main: {
        ru: "Основной mpv.conf",
        en: "Main mpv.conf",
      },
      app_settings_mpv_profile_name: {
        ru: "Имя нового профиля",
        en: "New profile name",
      },
      app_settings_mpv_profile_saveas: {
        ru: "Сохранить как…",
        en: "Save as…",
      },
      app_settings_mpv_profile_delete: { ru: "Удалить", en: "Delete" },
      app_settings_mpv_profile_saved: {
        ru: "Профиль mpv сохранён",
        en: "mpv profile saved",
      },
      app_settings_mpv_profile_deleted: {
        ru: "Профиль удалён",
        en: "Profile deleted",
      },
      app_settings_mpv_profile_menu: {
        ru: "Профиль mpv",
        en: "mpv profile",
      },
      app_settings_mpv_profile_off: { ru: "Без профиля", en: "No profile" },
      app_settings_mpv_profile_off_done: {
        ru: "Профиль mpv выключен",
        en: "mpv profile off",
      },
      app_settings_mpv_profile_on: {
        ru: "Профиль mpv:",
        en: "mpv profile:",
      },
      app_settings_mpv_profile_none: {
        ru: "Нет профилей mpv: создайте в Настройки → MPV и Загрузчик → Конфигурация mpv",
        en: "No mpv profiles: create one in Settings → MPV and Downloader → mpv configuration",
      },
      app_settings_mpv_applied_live: {
        ru: "Применено к текущему видео",
        en: "Applied to the current video",
      },
      app_settings_mpv_config_save: { ru: "Сохранить", en: "Save" },
      app_settings_mpv_config_cancel: { ru: "Отмена", en: "Cancel" },
      app_settings_mpv_config_clear: { ru: "Очистить", en: "Clear" },
      app_settings_mpv_config_saved: {
        ru: "Конфигурация mpv сохранена",
        en: "mpv configuration saved",
      },
      app_settings_mpv_config_error: {
        ru: "Не удалось сохранить",
        en: "Could not save",
      },
      app_settings_mpv_config_ignored: {
        ru: "Сохранено, но эти строки игнорируются:",
        en: "Saved, but these lines are ignored:",
      },
      app_settings_mpv_online_descr: {
        ru: "Выключено: онлайн и IPTV через HTML5. Включено: через встроенный mpv. Для торрентов пункт «Встроенный» всегда использует mpv. Изменение действует при следующем открытии видео.",
        en: "Off: online and IPTV use HTML5. On: use built-in mpv. The internal torrent player always uses mpv. Takes effect the next time a video opens.",
      },
    });
    Lampa.SettingsApi.addParam({
      component: SETTINGS_COMPONENT,
      param: { name: ONLINE_SETTING, type: "trigger", default: false },
      field: {
        name: Lampa.Lang.translate("app_settings_mpv_online"),
        description: Lampa.Lang.translate("app_settings_mpv_online_descr"),
      },
    });
    Lampa.SettingsApi.addParam({
      component: SETTINGS_COMPONENT,
      param: {
        name: BUFFER_SETTING,
        type: "select",
        values: {
          15: "15 с",
          30: "30 с",
          60: "60 с",
          120: "2 мин",
          300: "5 мин",
        },
        default: String(BUFFER_DEFAULT),
      },
      field: {
        name: Lampa.Lang.translate("app_settings_mpv_buffer"),
        description: Lampa.Lang.translate("app_settings_mpv_buffer_descr"),
      },
    });
    Lampa.SettingsApi.addParam({
      component: SETTINGS_COMPONENT,
      param: { name: CONFIG_BUTTON, type: "button" },
      field: {
        name: Lampa.Lang.translate("app_settings_mpv_config"),
        description: Lampa.Lang.translate("app_settings_mpv_config_descr"),
      },
      onChange: () => void openConfigEditor(),
    });
  }
})();
