(function () {
  "use strict";

  var STORAGE_KEY = "siteTheme";
  var TOGGLE_SELECTOR = "[data-theme-toggle]";
  var DARK_THEME = "dark";
  var LIGHT_THEME = "light";
  var THEME_COLOR_DARK = "#090813";
  var THEME_COLOR_LIGHT = "#f3f0ff";

  function normalizeTheme(value) {
    if (value === DARK_THEME || value === LIGHT_THEME) {
      return value;
    }
    return null;
  }

  function getSystemTheme() {
    if (
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: light)").matches
    ) {
      return LIGHT_THEME;
    }
    return DARK_THEME;
  }

  function readInitialTheme() {
    var inlineTheme = normalizeTheme(
      document.documentElement.getAttribute("data-theme")
    );
    if (inlineTheme) {
      return inlineTheme;
    }

    try {
      var stored = normalizeTheme(window.localStorage.getItem(STORAGE_KEY));
      if (stored) {
        return stored;
      }
    } catch (error) {
      // Ignore storage access errors and fall back to system preference.
    }

    return getSystemTheme();
  }

  function persistTheme(theme) {
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch (error) {
      // Ignore storage write errors.
    }
  }

  function updateMetaThemeColor(theme) {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      return;
    }
    meta.setAttribute(
      "content",
      theme === LIGHT_THEME ? THEME_COLOR_LIGHT : THEME_COLOR_DARK
    );
  }

  function dispatchTheme(theme, source) {
    document.dispatchEvent(
      new CustomEvent("site-theme-changed", {
        detail: {
          theme: theme,
          source: source || "toggle",
        },
      })
    );
  }

  function syncToggleControls(theme) {
    var toggles = document.querySelectorAll(TOGGLE_SELECTOR);
    var darkEnabled = theme === DARK_THEME;
    var i;
    for (i = 0; i < toggles.length; i += 1) {
      var toggle = toggles[i];
      toggle.checked = darkEnabled;
      toggle.setAttribute("aria-checked", darkEnabled ? "true" : "false");
    }
  }

  function applyTheme(theme, source) {
    var resolvedTheme = normalizeTheme(theme) || getSystemTheme();
    var root = document.documentElement;

    root.setAttribute("data-theme", resolvedTheme);
    root.classList.toggle("theme-dark", resolvedTheme === DARK_THEME);
    root.classList.toggle("theme-light", resolvedTheme === LIGHT_THEME);
    syncToggleControls(resolvedTheme);
    updateMetaThemeColor(resolvedTheme);
    dispatchTheme(resolvedTheme, source);
  }

  function bindControls() {
    var toggles = document.querySelectorAll(TOGGLE_SELECTOR);
    var i;
    for (i = 0; i < toggles.length; i += 1) {
      toggles[i].addEventListener("change", function (event) {
        var nextTheme = event.currentTarget.checked ? DARK_THEME : LIGHT_THEME;
        persistTheme(nextTheme);
        applyTheme(nextTheme, "switch");
      });
    }
  }

  function init() {
    var theme = readInitialTheme();
    applyTheme(theme, "init");
    bindControls();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
