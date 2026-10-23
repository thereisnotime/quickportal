/**
 * app.js - wiring only: fetch, parse, render, watch, keyboard.
 *
 * Everything that builds DOM lives in render.js; everything that persists
 * lives in state.js. This module decides when those happen, and it is the only
 * place that knows the config URL.
 *
 * The served tree is flat (ConfigMap keys cannot contain slashes), so every
 * import is a flat relative path and the config is at ./config/config.yaml.
 */

import { parseConfig, normalizeConfig, indexItems } from "./config.js";
import { getStoredTheme, setTheme, setCollapsed, getQuery, setQuery } from "./state.js";
import { openSet } from "./sets.js";
import { watchConfig } from "./reload.js";
import {
  renderPortal,
  renderIssues,
  renderNotice,
  applyFilter,
  setCollapsedAll,
} from "./render.js";

const CONFIG_URL = "./config/config.yaml";
const THEMES = ["auto", "light", "dark"];

const dom = {
  root: document.getElementById("portal"),
  search: document.getElementById("search"),
  searchClear: document.getElementById("search-clear"),
  themeToggle: document.getElementById("theme-toggle"),
  themeLabel: document.getElementById("theme-label"),
  reload: document.getElementById("reload-now"),
  paletteOpen: document.getElementById("palette-open"),
  palette: document.getElementById("palette"),
  paletteInput: document.getElementById("palette-input"),
  paletteList: document.getElementById("palette-list"),
  paletteEmpty: document.getElementById("palette-empty"),
  shortcutsOpen: document.getElementById("shortcuts-open"),
  shortcuts: document.getElementById("shortcuts"),
  live: document.getElementById("live"),
  status: document.getElementById("status"),
};

/** Last config that normalised cleanly. Kept so a broken live reload can keep
 *  showing something useful. */
let config = null;
let itemIndex = new Map();
let stopWatching = null;
let watchingInterval = null;
let loading = false;
let lastLoadedAt = null;
/** The exact text behind the current render, used to seed the watcher's hash. */
let lastText = null;

const handlers = {
  onOpenSet: handleOpenSet,
  onOpenItem: handleOpenItem,
  onToggleGroup: handleToggleGroup,
};

/* -------------------------------------------------------------------------
 * Storage access. state.js already swallows storage failures, but a module
 * that failed to load or a surprise throw must not take the page down.
 * ---------------------------------------------------------------------- */

function safely(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/* -------------------------------------------------------------------------
 * Theme
 * ---------------------------------------------------------------------- */

function applyTheme(theme) {
  const value = THEMES.includes(theme) ? theme : "auto";
  // data-theme on <html> is what app.css checks to beat the system preference.
  document.documentElement.dataset.theme = value;
  if (dom.themeLabel) dom.themeLabel.textContent = `Theme: ${value}`;
  if (dom.themeToggle) {
    dom.themeToggle.setAttribute(
      "aria-label",
      `Theme: ${value}. Activate to switch to ${nextTheme(value)}.`,
    );
  }
}

function nextTheme(theme) {
  return THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
}

function currentTheme() {
  const value = document.documentElement.dataset.theme;
  return THEMES.includes(value) ? value : "auto";
}

/**
 * The viewer's own choice wins over the config, which is the point of the
 * toggle. state.getStoredTheme() answers null when nothing is remembered, so a
 * deliberate pick of "auto" is still a pick and still beats `theme` in the
 * config.
 */
function applyConfigTheme(theme) {
  if (safely(() => getStoredTheme(), null) !== null) return;
  applyTheme(theme);
}

/* -------------------------------------------------------------------------
 * Loading and rendering
 * ---------------------------------------------------------------------- */

async function load() {
  if (loading) return;
  loading = true;
  try {
    let response;
    try {
      response = await fetch(CONFIG_URL, { cache: "no-store" });
    } catch (error) {
      reportFetchFailure(`the request failed: ${error && error.message}`);
      return;
    }
    if (!response.ok) {
      reportFetchFailure(`the server answered HTTP ${response.status}`);
      return;
    }
    applyConfigText(await response.text());
  } finally {
    loading = false;
  }
}

function reportFetchFailure(detail) {
  renderIssues(
    dom.root,
    [
      {
        path: CONFIG_URL,
        message: `The portal could not fetch its config, because ${detail}.`,
      },
    ],
    [],
  );
  announce("The config could not be fetched.");
  setStatus();
}

function applyConfigText(text) {
  const parsed = safely(() => parseConfig(text), null);
  if (!parsed) {
    renderIssues(dom.root, [{ path: CONFIG_URL, message: "The config could not be parsed." }], []);
    return;
  }
  if (parsed.errors && parsed.errors.length) {
    renderIssues(dom.root, parsed.errors, []);
    announce("The config could not be parsed.");
    return;
  }

  const result = normalizeConfig(parsed.raw) || {};
  const errors = result.errors || [];
  const warnings = result.warnings || [];

  // Whether there is anything to render is normalizeConfig's call, not a
  // pattern match on issue paths: it returns no config only when the document
  // itself is unusable (not a mapping, missing or future version). Anything
  // narrower than that, a dropped item or one set with a typo in its targets,
  // renders the rest of the tree with the problems listed above it. A single
  // bad entry blanking the whole portal is the behaviour worth avoiding.
  if (!result.config) {
    renderIssues(dom.root, errors, warnings);
    announce(`The config has ${errors.length} problem(s).`);
    return;
  }

  config = result.config;
  lastText = text;
  itemIndex = safely(() => indexItems(config), new Map()) || new Map();
  lastLoadedAt = new Date();

  // One of the stated goals of live reload: a re-render must not feel like a
  // page reload, so scroll, focus, collapse state and the query all survive.
  preserveWhile(() => {
    renderPortal(dom.root, config, handlers);
    renderIssues(dom.root, errors, warnings);
    applyFilter(dom.root, dom.search ? dom.search.value : "");
  });

  document.title = config.title ? `${config.title} - QuickPortal` : "QuickPortal";
  applyConfigTheme(config.theme);
  startWatching();
  setStatus();
}

/**
 * Run a render while holding on to what the user is doing. Nodes are
 * reconciled rather than replaced, so focus normally survives on its own; the
 * key lookup is the fallback for an element that genuinely had to be rebuilt.
 */
function preserveWhile(render) {
  const scrollY = window.scrollY;
  const active = document.activeElement;
  const inRoot = active && dom.root.contains(active);
  const focusKey = inRoot && active.dataset ? active.dataset.focusKey : null;

  render();

  if (inRoot && focusKey) {
    const lost = !document.activeElement || document.activeElement === document.body;
    if (lost) {
      const again = dom.root.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`);
      if (again) again.focus({ preventScroll: true });
    }
  }
  if (window.scrollY !== scrollY) window.scrollTo(0, scrollY);
}

function startWatching() {
  const interval = Number((config && config.reload && config.reload.interval) ?? 30);
  if (!(interval > 0)) {
    stopWatchingNow();
    return;
  }
  // Leave a healthy watcher alone, or every poll would reset its own timer.
  if (stopWatching && watchingInterval === interval) return;
  stopWatchingNow();
  watchingInterval = interval;
  stopWatching = safely(
    () =>
      watchConfig(CONFIG_URL, interval, onConfigChanged, {
        // Seeding the hash keeps the first poll from reporting the config we
        // have just rendered as a change.
        body: lastText,
        onError: (error) => announce(`Checking the config failed: ${error.message}`),
      }),
    null,
  );
}

/** Manual reload. Going through the watcher keeps its ETag and hash in step;
 *  without a watcher (reload.interval: 0) it is a plain fetch. */
function refreshNow() {
  if (stopWatching && typeof stopWatching.refresh === "function") {
    safely(() => stopWatching.refresh({ force: true }), null);
    return;
  }
  load();
}

function stopWatchingNow() {
  if (typeof stopWatching === "function") safely(() => stopWatching(), null);
  stopWatching = null;
  watchingInterval = null;
}

/** reload.js hands back the new body; accept a bare string or {text}. */
function onConfigChanged(payload) {
  const text =
    typeof payload === "string" ? payload : payload && typeof payload.text === "string" ? payload.text : null;
  if (text === null) {
    load();
    return;
  }
  applyConfigText(text);
  announce("The config changed and the page was updated.");
}

function setStatus() {
  if (!dom.status) return;
  if (!config) {
    dom.status.textContent = `No config loaded from ${CONFIG_URL}.`;
    return;
  }
  const bookmarks = itemIndex.size || 0;
  const reload =
    watchingInterval > 0 ? `live reload every ${watchingInterval}s` : "live reload off";
  const stamp = lastLoadedAt ? lastLoadedAt.toLocaleTimeString() : "never";
  dom.status.textContent = `${bookmarks} ${bookmarks === 1 ? "bookmark" : "bookmarks"} - loaded at ${stamp} - ${reload}`;
}

function announce(message) {
  if (dom.live) dom.live.textContent = message;
}

/* -------------------------------------------------------------------------
 * Handlers passed to render.js
 * ---------------------------------------------------------------------- */

function handleToggleGroup(id, collapsed) {
  safely(() => setCollapsed(id, collapsed), null);
}

function handleOpenItem(item) {
  if (item) announce(`Opening ${item.name || item.url}.`);
}

/**
 * Sets must open inside the click gesture, which is why sets.js does the
 * opening (and the confirmation for oversized sets) and we only report.
 */
function handleOpenSet(setId) {
  if (!config) return;
  const set = (config.sets || []).find((candidate) => candidate.id === setId);
  if (!set) return;

  let result;
  try {
    result = openSet(set, config);
  } catch (error) {
    renderNotice(dom.root, {
      kind: "error",
      id: `set:${setId}`,
      title: `Could not open ${set.name || setId}`,
      message: String((error && error.message) || error),
      dismissible: true,
    });
    return;
  }

  reportSetResult(set, result || {});
}

function reportSetResult(set, result) {
  const opened = Number(result.opened || 0);
  const blocked = Array.isArray(result.blocked) ? result.blocked : [];
  const name = set.name || set.id;

  if (result.confirmed === false) {
    announce("Nothing opened.");
    return;
  }
  if (!opened && !blocked.length) return; // the set resolved to nothing

  if (!blocked.length) {
    renderNotice(dom.root, {
      kind: "info",
      id: `set:${set.id}`,
      title: `${name}: ${opened} ${opened === 1 ? "tab" : "tabs"} opened`,
      dismissible: true,
    });
    announce(`${opened} ${opened === 1 ? "tab" : "tabs"} opened.`);
    return;
  }

  const links = blocked.map((entry) => ({
    name: entry.name || entry.url,
    url: entry.url,
  }));

  renderNotice(dom.root, {
    kind: "warn",
    id: `set:${set.id}`,
    title: opened
      ? `${name}: ${opened} opened, ${blocked.length} blocked`
      : `${name}: your browser blocked every tab`,
    message: opened
      ? "The browser refused the rest of the tabs. Open them from the list below, or allow pop-ups for this origin."
      : "Nothing opened. Allow pop-ups for this origin in your browser's site settings, or open the targets from the list below.",
    links,
    dismissible: true,
  });
  announce(`${opened} opened, ${blocked.length} blocked.`);
}

/* -------------------------------------------------------------------------
 * Search
 * ---------------------------------------------------------------------- */

function runFilter() {
  const query = dom.search.value;
  safely(() => setQuery(query), null);
  setHidden(dom.searchClear, !query);
  const matches = applyFilter(dom.root, query);
  if (query.trim()) {
    announce(`${matches} ${matches === 1 ? "bookmark matches" : "bookmarks match"}.`);
  }
}

function clearSearch(refocus) {
  dom.search.value = "";
  runFilter();
  if (refocus) dom.search.focus({ preventScroll: true });
}

function setHidden(node, hidden) {
  if (node && node.hidden !== hidden) node.hidden = hidden;
}

/* -------------------------------------------------------------------------
 * Command palette
 * ---------------------------------------------------------------------- */

const palette = {
  entries: [],
  shown: [],
  index: 0,
  opener: null,
};

function paletteEntries() {
  const entries = [];

  for (const [id, item] of itemIndex) {
    entries.push({
      kind: "Bookmark",
      name: item.name || id,
      meta: item.url,
      run: () => openUrl(item.url, item.target),
    });
  }

  for (const set of (config && config.sets) || []) {
    entries.push({
      kind: "Set",
      name: set.name || set.id,
      meta: `${(set.targets || []).length} targets`,
      run: () => handleOpenSet(set.id),
    });
  }

  entries.push(
    {
      kind: "Command",
      name: "Switch theme",
      meta: `currently ${currentTheme()}`,
      run: cycleTheme,
    },
    { kind: "Command", name: "Reload config now", meta: CONFIG_URL, run: refreshNow },
    {
      kind: "Command",
      name: "Expand all groups",
      meta: "",
      run: () => setAllGroups(false),
    },
    {
      kind: "Command",
      name: "Collapse all groups",
      meta: "",
      run: () => setAllGroups(true),
    },
    {
      kind: "Command",
      name: "Focus search",
      meta: "/",
      run: () => dom.search.focus({ preventScroll: true }),
    },
  );

  return entries;
}

function setAllGroups(collapsed) {
  const ids = setCollapsedAll(dom.root, collapsed) || [];
  for (const id of ids) safely(() => setCollapsed(id, collapsed), null);
  announce(collapsed ? "All groups collapsed." : "All groups expanded.");
}

function openPalette() {
  if (!dom.palette || typeof dom.palette.showModal !== "function") return;
  palette.opener = document.activeElement;
  palette.entries = paletteEntries();
  dom.paletteInput.value = "";
  renderPaletteList("");
  dom.palette.showModal();
  dom.paletteInput.focus({ preventScroll: true });
}

function renderPaletteList(query) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  palette.shown = palette.entries
    .filter((entry) => {
      if (!terms.length) return true;
      const haystack = `${entry.name} ${entry.meta} ${entry.kind}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    })
    .slice(0, 50);
  palette.index = 0;

  dom.paletteList.textContent = "";
  palette.shown.forEach((entry, i) => {
    const option = document.createElement("li");
    option.className = "palette-option";
    option.id = `palette-option-${i}`;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", i === 0 ? "true" : "false");

    const text = document.createElement("span");
    text.className = "opt-text";
    const name = document.createElement("span");
    name.className = "opt-name";
    name.textContent = entry.name;
    text.append(name);
    if (entry.meta) {
      const meta = document.createElement("span");
      meta.className = "opt-meta";
      meta.textContent = entry.meta;
      text.append(meta);
    }

    const kind = document.createElement("span");
    kind.className = "palette-kind";
    kind.textContent = entry.kind;

    option.append(text, kind);
    dom.paletteList.append(option);
  });

  setHidden(dom.paletteEmpty, palette.shown.length > 0);
  syncPaletteSelection();
}

function syncPaletteSelection() {
  const options = Array.from(dom.paletteList.children);
  options.forEach((option, i) => {
    option.setAttribute("aria-selected", i === palette.index ? "true" : "false");
  });
  const active = options[palette.index];
  if (active) {
    dom.paletteInput.setAttribute("aria-activedescendant", active.id);
    active.scrollIntoView({ block: "nearest" });
  } else {
    dom.paletteInput.removeAttribute("aria-activedescendant");
  }
}

function movePaletteSelection(delta) {
  if (!palette.shown.length) return;
  const count = palette.shown.length;
  palette.index = (palette.index + delta + count) % count;
  syncPaletteSelection();
}

function runPaletteSelection() {
  const entry = palette.shown[palette.index];
  if (!entry) return;
  dom.palette.close();
  // Run after the dialog closes so window.open is not attributed to it.
  entry.run();
}

function openUrl(url, target) {
  if (!url) return;
  if (target === "_self") window.location.assign(url);
  else window.open(url, "_blank", "noopener");
}

function cycleTheme() {
  const theme = nextTheme(currentTheme());
  // setTheme is what records the choice; storing it is also what makes the
  // config's own theme stop applying from here on.
  applyTheme(theme);
  safely(() => setTheme(theme), null);
  announce(`Theme set to ${theme}.`);
}

/* -------------------------------------------------------------------------
 * Dialog plumbing
 * ---------------------------------------------------------------------- */

function bindDialog(dialog) {
  if (!dialog) return;
  // Clicking the backdrop (the dialog element itself) closes it.
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
    const close = event.target.closest("[data-close-dialog]");
    if (close) dialog.close();
  });
}

function openDialog(dialog) {
  if (dialog && typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
}

/* -------------------------------------------------------------------------
 * Keyboard
 * ---------------------------------------------------------------------- */

function isTyping(target) {
  if (!target || !target.tagName) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function bindKeyboard() {
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented) return;

    if ((event.key === "k" || event.key === "K") && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (dom.palette.open) dom.palette.close();
      else openPalette();
      return;
    }

    if (dom.palette.open || dom.shortcuts.open) return; // dialogs handle their own keys

    if (event.key === "Escape") {
      if (dom.search.value) clearSearch(document.activeElement === dom.search);
      else if (document.activeElement === dom.search) dom.search.blur();
      return;
    }

    if (isTyping(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;

    if (event.key === "/") {
      event.preventDefault(); // preventScroll keeps the viewport where it was
      dom.search.focus({ preventScroll: true });
      dom.search.select();
    } else if (event.key === "?") {
      event.preventDefault();
      openDialog(dom.shortcuts);
    }
  });

  dom.paletteInput.addEventListener("input", () => renderPaletteList(dom.paletteInput.value));
  dom.paletteInput.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      movePaletteSelection(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      movePaletteSelection(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      runPaletteSelection();
    }
  });
  dom.paletteList.addEventListener("click", (event) => {
    const option = event.target.closest(".palette-option");
    if (!option) return;
    palette.index = Array.from(dom.paletteList.children).indexOf(option);
    runPaletteSelection();
  });
}

/* -------------------------------------------------------------------------
 * Init
 * ---------------------------------------------------------------------- */

function init() {
  if (!dom.root) return;

  applyTheme(safely(() => getStoredTheme(), null) || "auto");

  const storedQuery = safely(() => getQuery(), "") || "";
  dom.search.value = storedQuery;
  setHidden(dom.searchClear, !storedQuery);

  dom.search.addEventListener("input", runFilter);
  dom.search.addEventListener("search", runFilter); // the native clear affordance
  dom.searchClear.addEventListener("click", () => clearSearch(true));
  dom.themeToggle.addEventListener("click", cycleTheme);
  dom.reload.addEventListener("click", () => {
    announce("Reloading the config.");
    refreshNow();
  });
  dom.paletteOpen.addEventListener("click", openPalette);
  dom.shortcutsOpen.addEventListener("click", () => openDialog(dom.shortcuts));

  bindDialog(dom.palette);
  bindDialog(dom.shortcuts);
  dom.palette.addEventListener("close", () => {
    if (palette.opener && palette.opener.isConnected) {
      palette.opener.focus({ preventScroll: true });
    }
  });

  dom.root.addEventListener("quickportal:clear-search", () => clearSearch(true));
  dom.root.addEventListener("quickportal:retry", () => load());

  bindKeyboard();
  setStatus();
  load();
}

init();
