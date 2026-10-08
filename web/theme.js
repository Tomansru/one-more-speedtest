// @ts-check
// One More Speedtest — colour theme: auto (follows the system), light or dark.
// A classic script loaded from <head>, so the theme is set before the first
// paint. A manual choice is remembered in localStorage; auto is the default.
// Pages that draw with theme colours listen for the "themechange" event.

(() => {
  const STORAGE_KEY = "theme";
  /** Browser UI colour for each theme; matches --bg in style.css. */
  const BAR_COLORS = { light: "#f4f6fb", dark: "#0b0e14" };

  const root = document.documentElement;
  const systemLight = matchMedia("(prefers-color-scheme: light)");

  /** @typedef {"auto" | "light" | "dark"} ThemeChoice */

  /**
   * @param {string | null} value
   * @returns {ThemeChoice}
   */
  const parse = (value) => (value === "light" || value === "dark" ? value : "auto");

  /** @returns {ThemeChoice} */
  function load() {
    try {
      return parse(localStorage.getItem(STORAGE_KEY));
    } catch {
      return "auto"; // storage blocked (privacy settings): fall back to the system theme
    }
  }

  /** @param {ThemeChoice} choice */
  function save(choice) {
    try {
      if (choice === "auto") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, choice);
    } catch {
      // Storage blocked: the choice lasts until the page is closed.
    }
  }

  /** @returns {NodeListOf<HTMLInputElement>} */
  const radios = () => document.querySelectorAll('input[name="theme"]');

  let choice = load();

  // Sets data-theme on <html> to the theme in effect, which style.css keys on.
  function apply() {
    const theme = choice === "auto" ? (systemLight.matches ? "light" : "dark") : choice;
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
      meta.setAttribute("content", BAR_COLORS[theme]);
    }
    if (root.dataset.theme === theme) return;
    root.dataset.theme = theme;
    window.dispatchEvent(new CustomEvent("themechange", { detail: theme }));
  }

  function syncRadios() {
    for (const input of radios()) input.checked = input.value === choice;
  }

  apply();
  systemLight.addEventListener("change", apply);

  document.addEventListener("DOMContentLoaded", () => {
    syncRadios();
    for (const input of radios()) {
      input.addEventListener("change", () => {
        choice = parse(input.value);
        save(choice);
        apply();
      });
    }
  });

  // The same choice in another tab of this site.
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY && e.key !== null) return;
    choice = load();
    syncRadios();
    apply();
  });
})();
