(function () {
  "use strict";

  var STORAGE_KEY = "siteAnimationsEnabled";
  var TOGGLE_SELECTOR = "[data-animation-toggle]";

  function readInitialState() {
    try {
      var stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === "true") {
        return true;
      }
      if (stored === "false") {
        return false;
      }
    } catch (error) {
      // Ignore storage access errors and fall back to media query.
    }

    return !(
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  function persistState(enabled) {
    try {
      window.localStorage.setItem(STORAGE_KEY, enabled ? "true" : "false");
    } catch (error) {
      // Ignore storage write errors.
    }
  }

  function dispatchState(enabled, source) {
    document.dispatchEvent(
      new CustomEvent("site-animations-changed", {
        detail: {
          enabled: enabled,
          source: source || "toggle",
        },
      })
    );
  }

  function syncToggleControls(enabled) {
    var toggles = document.querySelectorAll(TOGGLE_SELECTOR);
    var i;
    for (i = 0; i < toggles.length; i += 1) {
      var toggle = toggles[i];
      toggle.checked = enabled;
      toggle.setAttribute("aria-checked", enabled ? "true" : "false");
    }
  }

  function applyState(enabled, source) {
    document.documentElement.classList.toggle("animations-off", !enabled);
    document.documentElement.setAttribute(
      "data-animations",
      enabled ? "on" : "off"
    );
    syncToggleControls(enabled);
    dispatchState(enabled, source);
  }

  function bindControls() {
    var toggles = document.querySelectorAll(TOGGLE_SELECTOR);
    var i;
    for (i = 0; i < toggles.length; i += 1) {
      toggles[i].addEventListener("change", function (event) {
        var enabled = Boolean(event.currentTarget.checked);
        persistState(enabled);
        applyState(enabled, "switch");
      });
    }
  }

  function init() {
    var enabled = readInitialState();
    applyState(enabled, "init");
    bindControls();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
