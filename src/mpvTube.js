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
  // The native addon exists only on macOS builds that bundled it.
  api
    .available()
    .then((ok) => ok && install())
    .catch(() => {});

  function install() {
    const ONLINE_SETTING = "mpv_online_enabled";
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

    const torrentChoices = Lampa.Params?.values?.player_torrent;
    if (torrentChoices && Lampa.Params?.select) {
      Lampa.Params.select(
        "player_torrent",
        {
          ...torrentChoices,
          inner: "Встроенный (MPV)",
          mpv: "MPV",
        },
        "inner",
      );
    }

    function onlineMpvEnabled() {
      const value = Lampa.Storage.get(ONLINE_SETTING, false);
      return value === true || value === "true";
    }

    function enabled() {
      return (
        (need === "player_torrent" || onlineMpvEnabled()) &&
        replacesChoice(Lampa.Storage.field(need))
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
      const playback = playData || {};
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
            mpvOptions: { sid: "no" },
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

    Lampa.PlayerVideo.registerTube({
      name: "mpv",
      verify: (src) => enabled() && /^(https?|file):/i.test(String(src)),
      create: (callback) => {
        addStyle();
        const shim = createShim();
        active = shim;
        callback(shim);
        return $(shim);
      },
    });

    Lampa.Lang.add({
      app_settings_mpv_online: {
        ru: "Использовать mpv для онлайн",
        en: "Use mpv for online playback",
      },
      app_settings_mpv_online_descr: {
        ru: "Выключено: онлайн и IPTV через HTML5. Включено: через встроенный mpv. Для торрентов пункт «Встроенный» всегда использует mpv. Изменение действует при следующем открытии видео.",
        en: "Off: online and IPTV use HTML5. On: use built-in mpv. The internal torrent player always uses mpv. Takes effect the next time a video opens.",
      },
    });
    Lampa.SettingsApi.addParam({
      component: "player",
      param: { name: ONLINE_SETTING, type: "trigger", default: false },
      field: {
        name: Lampa.Lang.translate("app_settings_mpv_online"),
        description: Lampa.Lang.translate("app_settings_mpv_online_descr"),
      },
    });
  }
})();
