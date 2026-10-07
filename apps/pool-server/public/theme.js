/* Shared loean theme switcher. The current theme is local to this browser. */
(function () {
  const STORAGE_KEY = "loean-ui-theme";
  const root = document.documentElement;

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

  if (!root.dataset.theme) {
    root.dataset.theme = readStored();
  }
  /* 语言切换后，主题按钮上的「浅色/深色」也随之刷新 */
  document.addEventListener("loean:langchange", () => updateControls(normalize(root.dataset.theme)));
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind, { once: true });
  } else {
    bind();
  }
})();
