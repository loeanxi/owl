/* Standalone pages keep their theme; an embedded manager follows Owl's appearance. */
(function () {
  const STORAGE_KEY = "loean-ui-theme";
  const SESSION_KEY = "owl-embedded-theme";
  const root = document.documentElement;
  const params = new URLSearchParams(window.location.search);
  const colorNames = ["canvas", "panel", "sidebar", "hover", "border", "text", "muted", "accent", "accentHover"];
  let parentOrigin = "";
  let embeddedTheme = "dark";
  if (window.parent !== window) {
    let config;
    try {
      config = params.has("owlParentOrigin")
        ? { origin: params.get("owlParentOrigin"), theme: params.get("owlTheme") }
        : JSON.parse(window.sessionStorage.getItem(SESSION_KEY));
    } catch {
      // Disabled storage must not stop an explicitly configured Owl iframe.
    }
    if (config && typeof config === "object" && !Array.isArray(config) && typeof config.origin === "string") {
      try {
        const origin = new URL(config.origin).origin;
        if (origin !== "null" && config.origin === origin) {
          parentOrigin = origin;
          embeddedTheme = normalize(config.theme);
        }
      } catch {
        // Unconfigured or invalid embedding contexts keep the standalone theme.
      }
    }
  }

  function normalize(theme) {
    return theme === "light" ? "light" : "dark";
  }

  function readStored() {
    try {
      return normalize(window.localStorage.getItem(STORAGE_KEY));
    } catch {
      return "dark";
    }
  }

  function updateControls(theme) {
    /* 运行时文案走 i18n 词表；i18n.js 未加载时回退中文，保证单独引用 theme.js 也不报错 */
    const t = (key, fallback) => (window.loeanI18n ? window.loeanI18n.t(key) : fallback);
    document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
      const isLight = theme === "light";
      button.setAttribute("aria-pressed", String(isLight));
      button.setAttribute("title", isLight
        ? t("common.theme.toggle.title.light", "切换到深色主题")
        : t("common.theme.toggle.title", "切换到浅色主题"));
      const label = button.querySelector("[data-theme-label]");
      if (label) {
        label.textContent = isLight
          ? t("common.theme.toggle.label.light", "深色")
          : t("common.theme.toggle.label", "浅色");
      }
      const icon = button.querySelector("[data-theme-icon]");
      if (icon) icon.textContent = isLight ? "◐" : "☼";
    });
  }

  function setTheme(next, persist) {
    const theme = normalize(next);
    if (persist !== false && parentOrigin) {
      window.parent.postMessage({ type: "owl:theme:set", theme }, parentOrigin);
      return;
    }
    root.dataset.theme = theme;
    if (persist !== false) {
      try {
        window.localStorage.setItem(STORAGE_KEY, theme);
      } catch {
        // Private browsing or disabled storage should not stop the page from switching themes.
      }
    }
    updateControls(theme);
    window.dispatchEvent(new CustomEvent("loean:themechange", { detail: { theme } }));
  }

  function bind() {
    updateControls(normalize(root.dataset.theme));
    document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
      button.addEventListener("click", () => {
        setTheme(root.dataset.theme === "light" ? "dark" : "light", true);
      });
    });
  }

  window.loeanTheme = {
    current: () => normalize(root.dataset.theme),
    set: (theme) => setTheme(theme, true),
    toggle: () => setTheme(root.dataset.theme === "light" ? "dark" : "light", true),
  };

  root.dataset.theme = parentOrigin ? embeddedTheme : readStored();
  function rememberEmbeddedTheme(theme) {
    try {
      window.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ origin: parentOrigin, theme }));
    } catch {
      // The current page still receives its palette when session storage is disabled.
    }
  }
  if (parentOrigin) {
    rememberEmbeddedTheme(embeddedTheme);
    window.addEventListener("message", (event) => {
      if (event.source !== window.parent || event.origin !== parentOrigin) return;
      const data = event.data;
      if (!data || typeof data !== "object" || Array.isArray(data) || data.type !== "owl:theme") return;
      if (data.theme !== "dark" && data.theme !== "light") return;
      const colors = data.colors;
      if (!colors || typeof colors !== "object" || Array.isArray(colors)) return;
      if (!colorNames.every((name) => typeof colors[name] === "string" && CSS.supports("color", colors[name]))) return;
      for (const name of colorNames) {
        const token = name === "accentHover" ? "accent-hover" : name;
        root.style.setProperty(`--owl-${token}`, colors[name]);
      }
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (context) {
        // Browser color parsing also handles rgb(), color-mix(), and translucent custom accents.
        for (const color of [data.theme === "light" ? "#ffffff" : "#1e1e1e", colors.canvas, colors.accent]) {
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
        }
        const pixel = context.getImageData(0, 0, 1, 1).data;
        const channels = Array.from(pixel).slice(0, 3).map((value) => {
          const channel = value / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
        const darkContrast = (luminance + 0.05) / (0.005605 + 0.05);
        const lightContrast = 1.05 / (luminance + 0.05);
        const foreground = Math.max(darkContrast, lightContrast) < 4.5
          ? "#000000" : darkContrast >= lightContrast ? "#111111" : "#ffffff";
        root.style.setProperty("--on-accent", foreground);
      }
      root.dataset.owlEmbedded = "true";
      rememberEmbeddedTheme(data.theme);
      setTheme(data.theme, false);
    });
    window.parent.postMessage({ type: "owl:theme:request" }, parentOrigin);
  }
  /* 语言切换后，主题按钮上的「浅色/深色」也随之刷新 */
  document.addEventListener("loean:langchange", () => updateControls(normalize(root.dataset.theme)));
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind, { once: true });
  } else {
    bind();
  }
})();
