// Small dark translucent notice, used for mpv profile changes and downloads.
// Lampa's own notice is a bright full-width bar; this one is a box with white
// text, like the rest of Lampa's overlays.
(function () {
  if (window.desktopToast) return;
  window.desktopToast = function (text) {
    if (!document.getElementById("mpv-toast-style")) {
      const style = document.createElement("style");
      style.id = "mpv-toast-style";
      style.textContent = `
        .mpv-toast {
          position: fixed; left: 50%; bottom: 9em; z-index: 99;
          max-width: 80%; padding: 0.9em 1.6em; border-radius: 1em;
          background: rgba(0, 0, 0, 0.7); color: #fff; line-height: 1.4;
          font-size: 1.2em; text-align: center; pointer-events: none;
          -webkit-backdrop-filter: blur(1em); backdrop-filter: blur(1em);
          transform: translate(-50%, 1em); opacity: 0;
          transition: opacity 0.3s, transform 0.3s;
        }
        .mpv-toast--visible { transform: translate(-50%, 0); opacity: 1; }`;
      document.head.appendChild(style);
    }
    document.querySelector(".mpv-toast")?.remove();
    const box = document.createElement("div");
    box.className = "mpv-toast";
    box.textContent = text;
    document.body.appendChild(box);
    requestAnimationFrame(() => box.classList.add("mpv-toast--visible"));
    setTimeout(() => {
      box.classList.remove("mpv-toast--visible");
      setTimeout(() => box.remove(), 400);
    }, 3500);
  };
})();
