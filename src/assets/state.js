// Per-browser state: theme, which groups are collapsed, and the search query.
//
// There is no server, so all of this lives in localStorage. Storage can be
// missing or blocked (private windows, "block third-party data", file://), and
// the page must still render, so every access is wrapped and every getter has a
// fallback. Each function takes an optional storage object as its last argument,
// which is how the tests run without a browser.

const KEY_THEME = "quickportal.theme";
const KEY_COLLAPSED = "quickportal.collapsed";
const KEY_QUERY = "quickportal.query";
const KEY_OPEN_TABS = "quickportal.openTabs";

const THEMES = ["auto", "light", "dark"];

export const DEFAULT_THEME = "auto";

// Resolved per call rather than at import time, so this module can be imported
// where no DOM exists.
function resolveStorage(storage) {
  if (storage) return storage;
  try {
    return globalThis.localStorage || null;
  } catch {
    return null; // Access itself throws when storage is blocked by policy.
  }
}

function readRaw(key, storage) {
  const store = resolveStorage(storage);
  if (!store) return null;
  try {
    const value = store.getItem(key);
    return value === undefined ? null : value;
  } catch {
    return null;
  }
}

function writeRaw(key, value, storage) {
  const store = resolveStorage(storage);
  if (!store) return false;
  try {
    store.setItem(key, value);
    return true;
  } catch {
    return false; // Quota exceeded, or storage is read-only.
  }
}

function removeRaw(key, storage) {
  const store = resolveStorage(storage);
  if (!store) return false;
  try {
    store.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {object} [storage]
 * @returns {"auto"|"light"|"dark"} the remembered theme, or "auto".
 */
export function getTheme(storage) {
  const value = readRaw(KEY_THEME, storage);
  return THEMES.includes(value) ? value : DEFAULT_THEME;
}

/**
 * The remembered theme, or null when the viewer has never chosen one.
 *
 * getTheme() cannot answer this: it returns "auto" both for a remembered
 * "auto" and for nothing remembered at all, so a caller could not tell a
 * deliberate choice of "auto" from an absent one, and a config's own `theme`
 * would either always lose or always win. Anything that has to respect "the
 * viewer's choice beats the config" wants this one.
 *
 * @param {object} [storage]
 * @returns {string|null}
 */
export function getStoredTheme(storage) {
  const value = readRaw(KEY_THEME, storage);
  return THEMES.includes(value) ? value : null;
}

/**
 * @param {string} theme one of auto, light, dark
 * @param {object} [storage]
 * @returns {boolean} whether it was remembered.
 */
export function setTheme(theme, storage) {
  if (!THEMES.includes(theme)) return false;
  return writeRaw(KEY_THEME, theme, storage);
}

function readCollapsedMap(storage) {
  const raw = readRaw(KEY_COLLAPSED, storage);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {}; // Someone else wrote junk under our key; start over.
  }
}

/**
 * @param {string} id a group id
 * @param {boolean} [fallback] the config's initial state, used when nothing is
 *        remembered for this id.
 * @param {object} [storage]
 * @returns {boolean}
 */
export function isCollapsed(id, fallback = false, storage) {
  const map = readCollapsedMap(storage);
  const value = map[id];
  return typeof value === "boolean" ? value : Boolean(fallback);
}

/**
 * @param {string} id a group id
 * @param {boolean} collapsed
 * @param {object} [storage]
 * @returns {boolean} whether it was remembered.
 */
export function setCollapsed(id, collapsed, storage) {
  if (typeof id !== "string" || id === "") return false;
  const map = readCollapsedMap(storage);
  map[id] = Boolean(collapsed);
  return writeRaw(KEY_COLLAPSED, JSON.stringify(map), storage);
}

/**
 * @param {object} [storage]
 * @returns {string} the remembered search query, or "".
 */
export function getQuery(storage) {
  const value = readRaw(KEY_QUERY, storage);
  return typeof value === "string" ? value : "";
}

/**
 * An empty query is removed rather than stored, so a fresh browser and a
 * cleared search box behave the same.
 *
 * @param {string} query
 * @param {object} [storage]
 * @returns {boolean} whether it was remembered.
 */
export function setQuery(query, storage) {
  const value = typeof query === "string" ? query : "";
  if (value === "") return removeRaw(KEY_QUERY, storage);
  return writeRaw(KEY_QUERY, value, storage);
}

/**
 * The ids of the items whose tabs were open, in strip order.
 *
 * Only which apps were open is remembered, never anything from inside them:
 * restoring is a fresh mount, so the apps start over. Junk, duplicates and
 * non-strings are discarded rather than handed to the frame host, and an id
 * whose item has since left the config is the caller's to skip.
 *
 * @param {object} [storage]
 * @returns {string[]} the remembered ids, or [].
 */
export function getOpenTabs(storage) {
  const raw = readRaw(KEY_OPEN_TABS, storage);
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return []; // Someone else wrote junk under our key; start over.
  }
  if (!Array.isArray(parsed)) return [];
  const ids = [];
  for (const id of parsed) {
    if (typeof id !== "string" || id === "") continue;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * An empty set is removed rather than stored, so a fresh browser and one where
 * every tab was closed behave the same.
 *
 * @param {string[]} ids item ids, in strip order
 * @param {object} [storage]
 * @returns {boolean} whether it was remembered.
 */
export function setOpenTabs(ids, storage) {
  const list = Array.isArray(ids) ? ids : [];
  const clean = [];
  for (const id of list) {
    if (typeof id !== "string" || id === "") continue;
    if (!clean.includes(id)) clean.push(id);
  }
  if (clean.length === 0) return removeRaw(KEY_OPEN_TABS, storage);
  return writeRaw(KEY_OPEN_TABS, JSON.stringify(clean), storage);
}

/**
 * An in-memory stand-in for localStorage, for tests and for the case where the
 * real thing is unavailable.
 *
 * @returns {{getItem: Function, setItem: Function, removeItem: Function, clear: Function}}
 */
export function createMemoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
    removeItem(key) {
      data.delete(key);
    },
    clear() {
      data.clear();
    },
  };
}
