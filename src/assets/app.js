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
import {
  getStoredTheme,
  setTheme,
  setCollapsed,
  getQuery,
  setQuery,
  getOpenTabs,
  setOpenTabs,
  getDiagramOpen,
  setDiagramOpen,
} from "./state.js";
import { openSet } from "./sets.js";
import { watchConfig } from "./reload.js";
import { FRAME_DEFAULT_MAX, createFrameHost, watchFramePolicy } from "./frames.js";
import {
  renderPortal,
  renderIssues,
  renderNotice,
  applyFilter,
  setCollapsedAll,
  renderTabStrip,
  renderFrameNudge,
  renderDiagramPanel,
  DIAGRAM_SCOPE_ID,
} from "./render.js";
import {
  fetchDiagram,
  renderSource,
  sanitizeSvg,
  applyScopedCss,
  serializeSvg,
  toPng,
  PNG_DEFAULT_SCALE,
} from "./diagram.js";

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
  // Siblings of <main>, never descendants: moving an iframe reloads it, and
  // rebuilding an inlined SVG throws away the pan and zoom position.
  tabStrip: document.getElementById("tab-strip"),
  frameHost: document.getElementById("frame-host"),
  diagramPanel: document.getElementById("diagram-panel"),
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
  onOpenEmbedded: handleOpenEmbedded,
  onToggleGroup: handleToggleGroup,
};

/** The frame host, or null when embedding could not be set up at all. */
let frameHost = null;
/** Focus mode is view state, not a frame state: it unmounts nothing. */
let focusMode = false;
/** The remembered tab set is restored once, after the first clean config. */
let tabsRestored = false;
/** Set when a config change had a more specific thing to announce than "the
 *  config changed", which is a tab closing because its item is gone. */
let changeAnnounced = false;

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
  syncFrames();
  syncDiagram();
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
  // A tab closing because its item disappeared is the more useful sentence,
  // and the live region only holds one.
  if (changeAnnounced) changeAnnounced = false;
  else announce("The config changed and the page was updated.");
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
 * Embedded apps: the frame host, the strip, focus mode
 *
 * Every frame operation goes through frames.js. Nothing here creates, moves,
 * removes or navigates a frame element, because moving an <iframe> reloads it
 * and throws away whatever the user had open. The strip is rendered from the
 * host's onChange list and from nothing else.
 * ---------------------------------------------------------------------- */

const stripHandlers = {
  onFocusTab: (id) => safely(() => frameHost.focus(id), null),
  onCloseTab: closeFrame,
  onRefreshFocused: refreshFocusedFrame,
  onRefreshAll: refreshAllFrames,
  onCloseAll: closeAllFrames,
  onToggleFocusMode: () => setFocusMode(!focusMode),
};

/** Apps whose nudge has already been announced, so it is not repeated on
 *  every list change. Cleared when the host clears the flag. */
const nudgeAnnounced = new Set();

const nudgeHandlers = {
  onDismiss: (id) => {
    // The bar goes away with the button that was just activated, so focus is
    // moved on purpose rather than dropped on the document.
    const bar = document.getElementById("qp-frame-nudge");
    const cameFromBar = Boolean(bar && bar.contains(document.activeElement));
    safely(() => frameHost.dismissNudge(id), null);
    if (cameFromBar) focusSelectedTab();
    announce("Dismissed. The app stays open.");
  },
  onOpenExternal: (id) => announce(`Opening ${frameName(id)} in a browser tab.`),
};

/** The selected tab, or the portal when there is none left to focus. */
function focusSelectedTab() {
  const tab = dom.tabStrip && dom.tabStrip.querySelector('.tab[aria-selected="true"]');
  if (tab) tab.focus({ preventScroll: true });
  else dom.root.focus({ preventScroll: true });
}

function initFrames() {
  if (!dom.tabStrip || !dom.frameHost) return;

  frameHost = safely(
    () =>
      createFrameHost(dom.frameHost, {
        maxFrames: FRAME_DEFAULT_MAX,
        onChange: onFramesChanged,
      }),
    null,
  );
  if (!frameHost) return;

  // Our own CSP refusing a frame is the one thing about framing that is
  // knowable from here, so it is the one thing reported as fact.
  safely(() => watchFramePolicy(reportFramePolicyBlock), null);

  // Draw the (empty, hidden) strip once so its controls exist before the
  // first mount, and so a stale strip can never outlive a destroy().
  onFramesChanged([]);
}

/** The only thing the strip is rendered from. */
function onFramesChanged(list) {
  // The host keeps the item it mounted, which is the right thing for the frame
  // and the wrong thing for the label: a config change can rename an item, and
  // the tab should say what the config says now. Swapping the item in the view
  // model touches no frame.
  const tabs = (Array.isArray(list) ? list : []).map((tab) => {
    const current = itemIndex.get(tab.id);
    return current ? { ...tab, item: current } : tab;
  });
  const max = frameHost ? frameHost.max : FRAME_DEFAULT_MAX;

  // Nothing to look at means nothing to focus on: leaving focus mode here is
  // the only automatic change to it, and it unmounts nothing because there is
  // nothing left mounted.
  if (!tabs.length && focusMode) setFocusMode(false);

  renderTabStrip(dom.tabStrip, { tabs, max, focusMode }, stripHandlers);

  // The nudge is offered for the frame the user is actually looking at; the
  // host keeps the flag per frame, so switching tabs brings it back.
  const focused = tabs.find((tab) => tab.focused) || null;
  const nudged = focused && focused.nudged ? focused : null;
  renderFrameNudge(dom.frameHost, { tab: nudged, docsUrl: docsUrl() }, nudgeHandlers);

  // The bar appears without anyone asking, so it is announced once per app,
  // in the same conditional wording: it is a timer, not a diagnosis.
  if (nudged && !nudgeAnnounced.has(nudged.id)) {
    nudgeAnnounced.add(nudged.id);
    announce(
      `If ${frameName(nudged.id)} has not loaded, a way out is offered below the app.`,
    );
  }
  for (const id of Array.from(nudgeAnnounced)) {
    if (!tabs.some((tab) => tab.id === id && tab.nudged)) nudgeAnnounced.delete(id);
  }

  // Which apps were open, never anything from inside them. Not persisted
  // before the remembered set has been restored, or the first render would
  // overwrite it with nothing.
  if (tabsRestored) safely(() => setOpenTabs(tabs.map((tab) => tab.id)), null);
}

/** Frame state that depends on the config: the cap, deleted items, restore. */
function syncFrames() {
  if (!frameHost) return;

  const max = Number(config && config.embedding && config.embedding.maxFrames);
  safely(() => frameHost.setMax(max > 0 ? max : FRAME_DEFAULT_MAX), null);

  // An item can be deleted out from under a mounted frame by a live reload.
  // The frame survived the re-render untouched; the tab should not survive the
  // item, and the user is told why rather than left with a tab pointing at
  // nothing.
  const closed = safely(() => frameHost.pruneMissing(itemIndex), []) || [];
  for (const entry of closed) {
    const name = (entry.item && entry.item.name) || entry.id;
    renderNotice(dom.root, {
      kind: "info",
      id: `frame-gone:${entry.id}`,
      title: `Closed ${name}`,
      message: "The item was removed from the config, so its tab no longer pointed at anything.",
      dismissible: true,
    });
  }
  if (closed.length) {
    announce(
      `The config changed. ${closed.length} ${closed.length === 1 ? "tab was" : "tabs were"} ` +
        "closed: the items are gone from the config.",
    );
    changeAnnounced = true;
  }

  if (!tabsRestored) restoreTabs();
  if (config && config.embedding && config.embedding.enabled) extendShortcuts();
}

/**
 * Reopen the apps that were open last time. The host skips ids that are no
 * longer in the config, and the stored set is rewritten from what it mounted,
 * which is how a deleted item's entry is discarded silently.
 */
function restoreTabs() {
  tabsRestored = true;
  const ids = safely(() => getOpenTabs(), []) || [];
  if (!ids.length) return;

  const result = safely(() => frameHost.restore(ids, itemIndex), null) || { mounted: [] };
  const mounted = result.mounted || [];
  safely(() => setOpenTabs(mounted), null);
  if (!mounted.length) return;
  // Restoring is a fresh mount. Saying so is the honest version: nothing of
  // what was inside those apps survived the page reload.
  announce(
    `${mounted.length} ${mounted.length === 1 ? "app was" : "apps were"} reopened from scratch.`,
  );
}

/** The primary action of an embedded item: open it inside the portal. */
function handleOpenEmbedded(item) {
  if (!item) return;
  if (!frameHost) {
    // No host at all: a browser tab is better than nothing happening.
    openUrl(item.url, item.target);
    return;
  }

  const result = safely(() => frameHost.open(item), null) || {};
  const name = item.name || item.url;

  if (result.evicted) {
    const evicted = (result.evicted.item && result.evicted.item.name) || result.evicted.id;
    renderNotice(dom.root, {
      kind: "info",
      id: "frames-evicted",
      title: `Closed ${evicted} to stay within ${frameHost.max} open apps`,
      message:
        "The app that had gone longest without being focused was closed, which " +
        "discards whatever it held. Raise embedding.maxFrames in the config to " +
        "keep more open at once.",
      dismissible: true,
    });
    announce(`${name} opened. ${evicted} was closed to stay within the limit.`);
    return;
  }

  if (result.mounted) announce(`${name} opened in the portal.`);
  else if (result.focused) announce(`${name} is already open; brought it to the front.`);
}

function closeFrame(id) {
  if (!frameHost) return;
  const name = frameName(id);
  const closed = safely(() => frameHost.close(id), null);
  if (closed) announce(`Closed ${name}.`);
}

/**
 * Closing several apps at once is destructive in the same way an oversized set
 * is, so it asks first above one. The host deliberately does not prompt on its
 * own, so that there is exactly one dialog and it is this one.
 */
function closeAllFrames() {
  if (!frameHost) return;
  const count = safely(() => frameHost.count(), 0) || 0;
  if (!count) return;

  // Where focus was before the strip and its controls disappear. Hiding the
  // element focus is sitting on drops it on the document, so it is moved
  // deliberately instead.
  const cameFromStrip = inStrip(document.activeElement);

  const result =
    safely(() => frameHost.closeAll({ confirm: (message) => window.confirm(message) }), null) || {};
  if (result.confirmed === false) {
    announce("Nothing closed.");
    return;
  }
  const closed = (result.closed || []).length;
  announce(`Closed ${closed} ${closed === 1 ? "app" : "apps"}.`);
  if (cameFromStrip) dom.root.focus({ preventScroll: true });
}

/** Whether an element is the strip or one of its controls. */
function inStrip(element) {
  if (!element) return false;
  const controls = document.getElementById("qp-tabstrip-controls");
  return Boolean(
    (dom.tabStrip && dom.tabStrip.contains(element)) || (controls && controls.contains(element)),
  );
}

function refreshFocusedFrame() {
  if (!frameHost) return;
  const id = safely(() => frameHost.focusedId(), null);
  if (!id) return;
  const name = frameName(id);
  safely(() => frameHost.refresh(id), null);
  // Refresh is a navigation and the only thing allowed to be one; it is never
  // automatic, because it discards the app's state.
  announce(`Reloading ${name}.`);
}

function refreshAllFrames() {
  if (!frameHost) return;
  const count = safely(() => frameHost.refreshAll(), 0) || 0;
  if (!count) return;
  announce(`Reloading ${count} ${count === 1 ? "app" : "apps"}. Nothing was closed.`);
}

/**
 * Focus mode: chrome only. It hides the toolbar, the tree and the footer,
 * keeps the strip, and unmounts nothing, which is the whole point of it.
 */
function setFocusMode(on) {
  const next = Boolean(on) && frameCount() > 0;
  if (next === focusMode) return;
  focusMode = next;
  if (focusMode) document.body.dataset.focusMode = "on";
  else delete document.body.dataset.focusMode;

  renderTabStrip(
    dom.tabStrip,
    { tabs: frameList(), max: frameHost ? frameHost.max : FRAME_DEFAULT_MAX, focusMode },
    stripHandlers,
  );
  announce(focusMode ? "Focus mode on. Press Escape to leave it." : "Focus mode off.");
}

/**
 * Our own Content-Security-Policy refused a frame. Unlike the target's
 * headers, this one is knowable, so it is stated plainly and names the thing
 * to change.
 */
function reportFramePolicyBlock(report) {
  const blocked = (report && report.blockedURI) || "an embedded app";
  renderNotice(dom.root, {
    kind: "error",
    id: "frame-policy",
    title: "This deployment's own policy is blocking embedded apps",
    message:
      `The portal's Content-Security-Policy refused to load ${blocked} in a frame. ` +
      "This is QuickPortal's own header, not the app's: embedding needs two " +
      "changes, and only the item's `embed: true` has been made.",
    hints: [
      "Widen frame-src in the server config ConfigMap to list the origins you embed; it ships as frame-src 'none'.",
      "frame-ancestors 'none' on the portal itself stays as it is: it is what stops anyone framing the portal.",
      "Until the policy allows it, the apps still open in a browser tab from the arrow next to each card.",
    ],
    dismissible: true,
  });
  announce("The portal's own policy is blocking embedded apps.");
}

function frameList() {
  if (!frameHost) return [];
  return safely(() => frameHost.list(), []) || [];
}

function frameCount() {
  if (!frameHost) return 0;
  return safely(() => frameHost.count(), 0) || 0;
}

function frameName(id) {
  const entry = frameList().find((tab) => tab.id === id);
  if (entry && entry.item && entry.item.name) return entry.item.name;
  const item = itemIndex.get(id);
  return (item && (item.name || item.url)) || id;
}

/** An optional documentation link for the nudge bar, when a deployment has one. */
function docsUrl() {
  const url = config && config.embedding && config.embedding.docsUrl;
  return typeof url === "string" && url ? url : null;
}

/** The strip's keys, added to the shortcuts dialog once embedding is in use. */
let shortcutsExtended = false;

function extendShortcuts() {
  if (shortcutsExtended || !dom.shortcuts) return;
  const list = dom.shortcuts.querySelector(".shortcut-list");
  if (!list) return;
  shortcutsExtended = true;
  const rows = [
    [["←", "→"], "Move between open app tabs"],
    [["Delete"], "Close the focused app tab"],
    [["Esc"], "Leave focus mode"],
  ];
  for (const [keys, text] of rows) {
    const dt = document.createElement("dt");
    for (const key of keys) {
      const kbd = document.createElement("kbd");
      kbd.textContent = key;
      dt.append(kbd);
    }
    const dd = document.createElement("dd");
    dd.textContent = text;
    list.append(dt, dd);
  }
}

/* -------------------------------------------------------------------------
 * The diagram panel
 *
 * #diagram-panel is a sibling of <main>, so a config poll re-renders the
 * bookmark tree without touching the inlined SVG. Everything cached about the
 * diagram lives here, keyed on a fingerprint of `config.diagram`: a config
 * change re-renders the panel from the cache and only a change to the diagram's
 * own configuration throws it away and fetches again.
 *
 * Nothing here parses, sanitises or serialises anything itself. diagram.js owns
 * all of that, including the constructed stylesheet that keeps the renderer's
 * CSS working under `style-src 'self'`; this module decides when it happens and
 * turns its outcomes into the panel's model.
 * ---------------------------------------------------------------------- */

/** Directives that can refuse a dynamic import of the renderer module. */
const RENDERER_DIRECTIVES = ["script-src", "script-src-elem", "default-src"];

const diagram = {
  /** Whether the panel is open. Persisted, so it survives a reload. */
  open: false,
  /** JSON of the diagram's own configuration; a change invalidates the cache. */
  fingerprint: null,
  /** Bumped whenever the cache is dropped, so an in-flight load can tell that
   *  it is no longer the load anyone is waiting for. */
  generation: 0,
  state: "idle",
  loading: false,
  /** Whether this load goes through a renderer, for the loading wording. */
  renderer: false,
  el: null,
  dropped: null,
  droppedDismissed: false,
  error: null,
  /** Set when the committed SVG is shown because the renderer never loaded. */
  fallback: null,
  /** {scale, x, y}, or null to be fitted on first sight. Kept here rather than
   *  in the DOM so that a re-render hands it straight back. */
  zoom: null,
  busy: null,
  /** The stop() returned by applyScopedCss for the stylesheet in use. */
  stopCss: null,
};

const diagramHandlers = {
  onToggle: toggleDiagram,
  onZoom: (zoom) => {
    diagram.zoom = zoom;
    renderDiagram();
  },
  onExportSvg: exportDiagramSvg,
  onExportPng: exportDiagramPng,
  onRetry: retryDiagram,
  onDismissDrop: () => {
    diagram.droppedDismissed = true;
    renderDiagram();
  },
};

function diagramConfig() {
  return (config && config.diagram) || null;
}

/**
 * The diagram's own configuration, as a string, so a config change that did
 * not touch it is not a reason to fetch anything again. Written out field by
 * field rather than stringifying the section, so an unrelated key appearing
 * there later does not quietly invalidate every cache.
 */
function diagramFingerprint(d) {
  if (!d) return null;
  const renderer = d.renderer || null;
  return JSON.stringify([
    d.src ?? null,
    d.maxBytes ?? null,
    d.source ?? null,
    d.mode ?? null,
    renderer ? [renderer.url ?? null, renderer.options ?? null] : null,
  ]);
}

/**
 * Reconcile the panel with the config that has just been applied.
 *
 * The open state is deliberately untouched: a config change leaves the panel
 * as the user left it, and so is the cached diagram unless the diagram's own
 * configuration changed.
 */
function syncDiagram() {
  if (!dom.diagramPanel) return;
  const d = diagramConfig();
  const fingerprint = diagramFingerprint(d);

  if (fingerprint !== diagram.fingerprint) {
    diagram.fingerprint = fingerprint;
    resetDiagram();
  }

  if (d && diagram.open && diagram.state === "idle" && !diagram.loading) loadDiagram();
  else renderDiagram();

  if (d) extendDiagramShortcuts();
}

/** Drop everything cached about the diagram, but not the open state. */
function resetDiagram() {
  diagram.generation += 1;
  diagram.loading = false;
  diagram.state = "idle";
  diagram.renderer = false;
  diagram.el = null;
  diagram.cssExport = "";
  diagram.dropped = null;
  diagram.droppedDismissed = false;
  diagram.error = null;
  diagram.fallback = null;
  // A different diagram is a different picture, so the old position means
  // nothing and it is fitted again.
  diagram.zoom = null;
  diagram.busy = null;
  stopDiagramCss();
}

function stopDiagramCss() {
  if (typeof diagram.stopCss === "function") safely(() => diagram.stopCss(), null);
  diagram.stopCss = null;
}

function renderDiagram() {
  if (!dom.diagramPanel) return;
  const d = diagramConfig();
  renderDiagramPanel(
    dom.diagramPanel,
    {
      configured: Boolean(d),
      title: (d && d.title) || "Diagram",
      open: diagram.open,
      state: diagram.state,
      renderer: diagram.renderer,
      el: diagram.el,
      dropped: diagram.dropped,
      droppedDismissed: diagram.droppedDismissed,
      error: diagram.error,
      fallback: diagram.fallback,
      zoom: diagram.zoom,
      busy: diagram.busy,
    },
    diagramHandlers,
  );
}

/** The lazy part: nothing is fetched or rendered until the first open. */
function toggleDiagram(open) {
  diagram.open = Boolean(open);
  safely(() => setDiagramOpen(diagram.open), null);
  if (diagram.open && diagramConfig() && diagram.state === "idle" && !diagram.loading) {
    loadDiagram();
  } else {
    renderDiagram();
  }
  announce(
    diagram.open
      ? "Diagram panel opened."
      : "Diagram panel closed. The diagram stays loaded.",
  );
}

function retryDiagram() {
  if (!diagramConfig()) return;
  resetDiagram();
  announce("Loading the diagram again.");
  loadDiagram();
}

/**
 * Load, render or fetch, sanitise, mount.
 *
 * Every step reports a failure rather than throwing, and `attempt` covers the
 * case where one throws anyway: a diagram is decoration for most of what this
 * page is for, so nothing it does may reach the bookmarks.
 */
async function loadDiagram() {
  const d = diagramConfig();
  if (!d || diagram.loading) return;

  const generation = diagram.generation;
  diagram.loading = true;
  diagram.state = "loading";
  diagram.error = null;
  diagram.fallback = null;
  diagram.renderer = d.mode === "renderer";
  renderDiagram();

  try {
    const source = await obtainDiagramText(d);
    if (generation !== diagram.generation) return; // the config moved on

    if (!source.text) {
      setDiagramError(source.error || { kind: "other" });
      return;
    }

    const result = await attempt(() => sanitizeSvg(source.text, { scopeId: DIAGRAM_SCOPE_ID }));
    if (generation !== diagram.generation) return;

    if (!result || result.error || !result.el) {
      // sanitizeSvg answers `parse` for a malformed document and `unsupported`
      // where the browser has no DOMParser; both leave nothing to display, and
      // the detail distinguishes them.
      setDiagramError({
        kind: "parse",
        path: source.fallback ? d.src : diagramOrigin(d),
        detail: errorDetail(result && result.error),
      });
      return;
    }

    stopDiagramCss();
    if (result.css) diagram.stopCss = safely(() => applyScopedCss(result.css), null);

    diagram.el = result.el;
    // The unscoped stylesheet, for an exported file: the panel's container id
    // does not exist there, so the scoped sheet would style nothing and a
    // mermaid export would come out as unstyled shapes.
    diagram.cssExport = result.cssExport || "";
    diagram.dropped = result.dropped || null;
    diagram.droppedDismissed = false;
    diagram.fallback = source.fallback || null;
    diagram.error = null;
    diagram.state = "ready";
    // Null means "fit it": a freshly mounted diagram has no position yet.
    diagram.zoom = null;
    announceDiagramReady(result.dropped, source.fallback);
  } finally {
    if (generation === diagram.generation) {
      diagram.loading = false;
      renderDiagram();
    }
  }
}

/**
 * The SVG text, from the renderer or from the committed file.
 *
 * `mode: "renderer"` with a `src` as well is the one place this feature
 * degrades gracefully: a renderer module that never loaded falls back to the
 * committed copy, because an operator with no route to their CDN should get
 * their diagram rather than an apology. A renderer that loaded and then
 * errored is not that case, and is reported as itself.
 */
async function obtainDiagramText(d) {
  const viaRenderer = d.mode === "renderer" && d.renderer && d.renderer.url;

  if (viaRenderer) {
    const rendered = await renderDiagramSource(d);
    if (rendered.text) return { text: rendered.text };
    // `fallbackable` is diagram.js's own distinction between "the module
    // never loaded" and "it loaded and refused the source". Only the first is
    // a reason to show an older picture; substituting one for the second would
    // hide the operator's own mistake.
    if (rendered.error && rendered.error.fallbackable === true && d.src) {
      const fetched = await fetchDiagramFile(d);
      if (fetched.text) {
        return {
          text: fetched.text,
          fallback: {
            reason: rendered.error.kind === "renderer-blocked" ? "blocked" : "unreachable",
            url: d.renderer.url,
            path: d.src,
          },
        };
      }
      // Neither path worked. The renderer is the configured intent, so its
      // failure is the one worth naming; the fetch failure is the detail.
      return {
        error: {
          ...rendered.error,
          detail: `${errorDetail(rendered.error)} The committed copy at ${d.src} could not be read either.`.trim(),
        },
      };
    }
    return { error: rendered.error };
  }

  if (d.src) return fetchDiagramFile(d);
  return { error: { kind: "other", detail: "No diagram source is configured." } };
}

/**
 * Import the operator's renderer and draw the config's source with it.
 *
 * Our own policy refusing the import is the one thing about it that is
 * knowable from here, so it is watched for and reported as fact, exactly as
 * frames.js does for frame-src. Everything else is "that origin could not be
 * reached", because from inside the page a blocked route, a dead host and a
 * typo in the URL look identical.
 */
async function renderDiagramSource(d) {
  const url = d.renderer.url;
  let blocked = false;

  const onViolation = (event) => {
    const directive = String(event.violatedDirective || event.effectiveDirective || "")
      .trim()
      .split(/[\s;]/)[0];
    if (!RENDERER_DIRECTIVES.includes(directive)) return;
    if (!rendererOriginMatches(event.blockedURI, url)) return;
    blocked = true;
  };
  document.addEventListener("securitypolicyviolation", onViolation);

  let result;
  try {
    result = await attempt(() =>
      // maxBytes caps the rendered output too: three lines of source can
      // render into megabytes of SVG.
      renderSource(d.source, d.renderer, { maxBytes: d.maxBytes }),
    );
  } finally {
    // The violation report can land a tick after the import rejects, so the
    // listener outlives the call by one turn of the loop.
    await new Promise((resolve) => setTimeout(resolve, 0));
    document.removeEventListener("securitypolicyviolation", onViolation);
  }

  if (result && result.text && !result.error) return { text: result.text };

  const error = (result && result.error) || {};
  const detail = errorDetail(error);
  const origin = error.origin || originOf(url);

  // An oversized diagram is the same problem whichever path produced it.
  if (error.kind === "too-large") return { error: oversizeError(error, d, "The rendered diagram") };

  if (error.kind === "renderer-unreachable") {
    // diagram.js cannot tell a blocked import from an unreachable one, because
    // the browser does not say. The violation report does, and it is the one
    // thing here that is knowable as fact, so it upgrades the message and
    // names our own policy as the thing to change.
    return {
      error: {
        kind: blocked ? "renderer-blocked" : "renderer-unreachable",
        url,
        origin,
        // Only the engine's own cause. diagram.js's message around it is
        // advice for the same two cases the panel is already wording for
        // itself, and repeating it reads as a contradiction when the policy
        // turns out to be the half that is fine.
        detail: causeOf(detail),
        fallbackable: true,
      },
    };
  }

  // renderer-shape, renderer-failed: it loaded, and then did not give us an
  // SVG. Nothing to fall back to, and nothing about the origin to report.
  return {
    error: {
      kind: error.kind === "config" ? "other" : "render-failed",
      url,
      origin,
      detail,
      fallbackable: false,
    },
  };
}

async function fetchDiagramFile(d) {
  const result = await attempt(() => fetchDiagram(d.src, { maxBytes: d.maxBytes }));
  if (result && result.text && !result.error) return { text: result.text };
  return { error: fetchErrorFor(result && result.error, d) };
}

/**
 * Translate diagram.js's error into one of the panel's kinds.
 *
 * The contract pins the fields `fetchDiagram` returns but not the shape of the
 * error inside them, so this reads whatever is there and falls back on "it
 * could not be fetched", which is both the commonest cause and the safest
 * thing to say when the detail is unrecognised.
 */
function fetchErrorFor(error, d) {
  const kind = String((error && error.kind) || "");
  const detail = errorDetail(error);

  if (kind === "too-large") return oversizeError(error, d, d.src);
  if (kind === "parse") return { kind: "parse", path: d.src, detail };
  // config, unsupported, network, timeout, http: from the page's point of view
  // these are all "nothing usable came back from this path", and the detail
  // says which. Naming the path is the part the operator acts on.
  return { kind: "missing", path: d.src, detail };
}

/**
 * The oversize notice needs both numbers, and diagram.js carries them on the
 * error; the config's own maxBytes is the fallback for the permitted side.
 */
function oversizeError(error, d, subject) {
  const bytes = Number(error && error.bytes);
  const max = Number(error && error.maxBytes);
  return {
    kind: "too-large",
    path: subject || d.src,
    bytes: Number.isFinite(bytes) ? bytes : null,
    maxBytes: Number.isFinite(max) && max > 0 ? max : Number(d.maxBytes) || null,
    detail: "",
  };
}

/** What to call the thing that failed to parse, when there is no file. */
function diagramOrigin(d) {
  if (d.mode === "renderer" && d.renderer && d.renderer.url) return "the renderer's output";
  return d.src || "the diagram";
}

function setDiagramError(error) {
  stopDiagramCss();
  diagram.state = "error";
  diagram.error = error;
  diagram.el = null;
  diagram.dropped = null;
  diagram.fallback = null;
  diagram.zoom = null;
  announce("The diagram could not be shown. The bookmarks are unaffected.");
}

function announceDiagramReady(dropped, fallback) {
  const counts = dropped || {};
  const removed = Number.isFinite(Number(counts.total))
    ? Number(counts.total)
    : Number(counts.elements || 0) +
      Number(counts.attributes || 0) +
      Number(counts.declarations || 0) +
      Number(counts.rules || 0);
  const altered = removed > 0 ? " Part of it was removed by sanitising; the panel says what." : "";
  const older = fallback ? " It is the committed copy: the renderer could not be loaded." : "";
  announce(`The diagram is shown, fitted to the panel.${older}${altered}`);
}

/** Whatever an unknown error object has to say for itself, as a sentence. */
function errorDetail(error) {
  if (!error) return "";
  if (typeof error === "string") return error;
  const text = error.message || error.detail || error.reason || error.code || error.kind || "";
  return String(text || "");
}

/**
 * The parenthesised engine message at the end of a diagram.js error, which is
 * the part that says what actually went wrong, or the whole thing when there
 * is no such suffix.
 */
function causeOf(detail) {
  const match = /\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*$/.exec(String(detail || "").trim());
  return match ? match[1].trim() : String(detail || "");
}

function originOf(url) {
  try {
    return new URL(String(url), window.location.href).origin;
  } catch {
    return String(url || "");
  }
}

/** Whether a CSP report's blockedURI is the renderer we were importing. */
function rendererOriginMatches(blockedURI, url) {
  const blocked = String(blockedURI || "");
  if (!blocked) return false;
  const origin = originOf(url);
  if (blocked === origin || blocked === String(url)) return true;
  try {
    return new URL(blocked, window.location.href).origin === origin;
  } catch {
    // "inline", "eval" and other keywords are not URLs, and are not ours.
    return false;
  }
}

/** Await something that may throw instead of returning its error. */
async function attempt(fn) {
  try {
    const value = await fn();
    return value && typeof value === "object" ? value : { value };
  } catch (error) {
    return { error };
  }
}

/* ---- export -------------------------------------------------------------
 * Both exports are computed from the sanitised element on screen: no network
 * request, no dependency, and nothing that could reintroduce a reference the
 * sanitiser removed.
 * ---------------------------------------------------------------------- */

function exportDiagramSvg() {
  if (!diagram.el) return;
  let text = null;
  try {
    text = serializeSvg(diagram.el, { css: diagram.cssExport });
  } catch {
    text = null;
  }
  if (!text) {
    announce("The diagram could not be exported as SVG.");
    return;
  }
  downloadBlob(
    new Blob([text], { type: "image/svg+xml;charset=utf-8" }),
    `${diagramSlug()}.svg`,
  );
  announce("The diagram was exported as SVG.");
}

async function exportDiagramPng() {
  if (!diagram.el || diagram.busy) return;
  diagram.busy = "png";
  renderDiagram();
  try {
    let blob = null;
    try {
      blob = await toPng(diagram.el, { scale: PNG_DEFAULT_SCALE, css: diagram.cssExport });
    } catch {
      blob = null;
    }
    if (!blob) {
      announce("The diagram could not be exported as PNG.");
      return;
    }
    downloadBlob(blob, `${diagramSlug()}.png`);
    // Said out loud rather than left to be discovered: the canvas draws with
    // whatever font the browser resolved, not the one the diagram asked for.
    announce(
      `The diagram was exported as PNG at ${PNG_DEFAULT_SCALE}x. Text uses the font the browser substituted.`,
    );
  } finally {
    diagram.busy = null;
    renderDiagram();
  }
}

function diagramSlug() {
  const d = diagramConfig();
  const title = (d && d.title) || "diagram";
  const slug = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "diagram";
}

/**
 * Offer a blob as a download. A temporary <a download> is the only way to name
 * a file from a page, and `download` on a same-origin blob is not a navigation,
 * so nothing here depends on the policy.
 */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoked late: some browsers need the URL alive until the download starts.
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/** The panel's keys, added to the shortcuts dialog once a diagram exists. */
let diagramShortcutsExtended = false;

function extendDiagramShortcuts() {
  if (diagramShortcutsExtended || !dom.shortcuts) return;
  const list = dom.shortcuts.querySelector(".shortcut-list");
  if (!list) return;
  diagramShortcutsExtended = true;
  const rows = [
    [["←", "→", "↑", "↓"], "Pan the diagram (hold Shift to pan further)"],
    [["+", "-"], "Zoom the diagram in and out"],
    [["0"], "Fit the diagram to the panel"],
  ];
  for (const [keys, text] of rows) {
    const dt = document.createElement("dt");
    for (const key of keys) {
      const kbd = document.createElement("kbd");
      kbd.textContent = key;
      dt.append(kbd);
    }
    const dd = document.createElement("dd");
    dd.textContent = text;
    list.append(dt, dd);
  }
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
      // An embedded item opens where it is configured to open, from here too.
      run: () => (item.embed ? handleOpenEmbedded(item) : openUrl(item.url, item.target)),
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

  if (diagramConfig()) {
    const title = diagramConfig().title;
    entries.push({
      kind: "Command",
      name: diagram.open ? `Hide ${title}` : `Show ${title}`,
      meta: diagram.state === "ready" ? "loaded" : "the diagram panel",
      run: () => toggleDiagram(!diagram.open),
    });
    if (diagram.state === "ready") {
      entries.push(
        {
          kind: "Command",
          name: `Export ${title} as SVG`,
          meta: "computed in the browser",
          run: exportDiagramSvg,
        },
        {
          kind: "Command",
          name: `Export ${title} as PNG`,
          meta: `${PNG_DEFAULT_SCALE}x, fonts as the browser resolved them`,
          run: exportDiagramPng,
        },
      );
    }
  }

  const open = frameCount();
  if (open) {
    entries.push(
      {
        kind: "Command",
        name: focusMode ? "Leave focus mode" : "Enter focus mode",
        meta: "Esc leaves it",
        run: () => setFocusMode(!focusMode),
      },
      {
        kind: "Command",
        name: "Refresh all embedded apps",
        meta: `${open} open`,
        run: refreshAllFrames,
      },
      {
        kind: "Command",
        name: "Close all embedded apps",
        meta: `${open} open`,
        run: closeAllFrames,
      },
    );
  }

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

    if (event.key === "Escape" && focusMode) {
      // Focus mode first: the search box is not even on screen while it is on.
      event.preventDefault();
      setFocusMode(false);
      return;
    }

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

  // Read before the first config arrives, so that a panel the viewer left open
  // loads its diagram as soon as there is a diagram to load, and a panel they
  // left closed never asks for one.
  diagram.open = safely(() => getDiagramOpen(), false) === true;

  bindKeyboard();
  initFrames();
  setStatus();
  load();
}

init();
