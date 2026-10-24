// Per-browser state: theme, which groups are collapsed, and the search query.
//
// There is no server, so all of this lives in localStorage. Storage can be
// missing or blocked (private windows, "block third-party data", file://), and
// the page must still render, so every access is wrapped and every getter has a
// fallback. Each function takes an optional storage object as its last argument,
// which is how the tests run without a browser.

const KEY_THEME = "quickportal.theme";
const KEY_CONTRAST = "quickportal.contrast";
const KEY_DENSITY = "quickportal.density";
const KEY_MOTION = "quickportal.motion";
const KEY_COLLAPSED = "quickportal.collapsed";
const KEY_QUERY = "quickportal.query";
const KEY_OPEN_TABS = "quickportal.openTabs";
const KEY_DIAGRAM_OPEN = "quickportal.diagramOpen";

/** Kept as named exports because the theme predates the settings menu and
 *  both are part of this module's published surface. PREFERENCES.theme below
 *  is the single source of truth for both values. */
export const DEFAULT_THEME = "auto";

/**
 * The appearance preferences the settings menu offers, in the order it shows
 * them. Each one is an independent enum with its own key and its own default,
 * read and written independently, so a corrupt or missing value for one never
 * affects another.
 *
 * `auto` and `system` mean "do not interfere": the stylesheet is left to its
 * media queries. They are still real, storable choices, which is what lets a
 * viewer go back to following the OS after having once overridden it.
 *
 * Density is the one whose default is not fixed here: it comes from the
 * config's `layout.density`, and this table's "comfortable" is only the
 * fallback for when there is no config value either. See resolvePreference().
 *
 * Contrast and motion are deliberately absent from the config schema. Both are
 * accessibility preferences belonging to the person reading the page, and an
 * operator who could force either would be overriding an OS-level setting for
 * someone they cannot see.
 */
export const PREFERENCES = Object.freeze({
  theme: Object.freeze({
    key: KEY_THEME,
    options: Object.freeze(["auto", "light", "dark"]),
    default: "auto",
  }),
  contrast: Object.freeze({
    key: KEY_CONTRAST,
    options: Object.freeze(["auto", "normal", "high"]),
    default: "auto",
  }),
  density: Object.freeze({
    key: KEY_DENSITY,
    options: Object.freeze(["comfortable", "compact"]),
    default: "comfortable",
  }),
  motion: Object.freeze({
    key: KEY_MOTION,
    options: Object.freeze(["system", "reduced"]),
    default: "system",
  }),
});

/** @returns {string[]} the preference names, in the order to present them. */
export function preferenceNames() {
  return Object.keys(PREFERENCES);
}

/**
 * @param {string} name a preference name
 * @returns {{key: string, options: readonly string[], default: string}|null}
 */
function preference(name) {
  return Object.prototype.hasOwnProperty.call(PREFERENCES, name)
    ? PREFERENCES[name]
    : null;
}

/**
 * The remembered value of one preference, or null when the viewer has never
 * chosen it.
 *
 * This is the accessor anything respecting "the viewer's choice beats the
 * config" wants. getPreference() cannot answer it: it returns the default both
 * for a deliberate choice of the default and for nothing stored at all, so a
 * caller could not tell them apart and a config value would either always win
 * or always lose.
 *
 * @param {string} name
 * @param {object} [storage]
 * @returns {string|null}
 */
export function getStoredPreference(name, storage) {
  const pref = preference(name);
  if (!pref) return null;
  const value = readRaw(pref.key, storage);
  return pref.options.includes(value) ? value : null;
}

/**
 * @param {string} name
 * @param {object} [storage]
 * @returns {string} the remembered value, or this preference's default.
 */
export function getPreference(name, storage) {
  const pref = preference(name);
  if (!pref) return "";
  return getStoredPreference(name, storage) ?? pref.default;
}

/**
 * Remember one preference. An unrecognised value is refused rather than
 * stored, so a caller's typo cannot put the page into a state no stylesheet
 * covers.
 *
 * @param {string} name
 * @param {string} value one of this preference's options
 * @param {object} [storage]
 * @returns {boolean} whether it was remembered.
 */
export function setPreference(name, value, storage) {
  const pref = preference(name);
  if (!pref || !pref.options.includes(value)) return false;
  return writeRaw(pref.key, value, storage);
}

/**
 * Forget one preference, returning it to following the config or the system.
 *
 * @param {string} name
 * @param {object} [storage]
 * @returns {boolean} whether it was cleared.
 */
export function clearPreference(name, storage) {
  const pref = preference(name);
  if (!pref) return false;
  return removeRaw(pref.key, storage);
}

/**
 * The value to apply for one preference, given what the config asked for.
 *
 * The rule, the same one the theme has always used: a stored choice wins, then
 * the config's value, then the built-in default. Which is why a config edit
 * cannot fight a choice the viewer has made, and why a viewer who has chosen
 * nothing still gets what the operator configured.
 *
 * `configValue` is ignored unless it is one of this preference's options, so a
 * typo in the config falls through to the default rather than to nothing.
 *
 * @param {string} name
 * @param {string|null|undefined} configValue the config's value, if it has one
 * @param {object} [storage]
 * @returns {string}
 */
export function resolvePreference(name, configValue, storage) {
  const pref = preference(name);
  if (!pref) return "";
  const stored = getStoredPreference(name, storage);
  if (stored !== null) return stored;
  if (pref.options.includes(configValue)) return configValue;
  return pref.default;
}

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
 * Theme, in the vocabulary that predates the settings menu. These three are
 * thin wrappers over the generic preference accessors so there is one place
 * that decides what a valid theme is.
 *
 * @param {object} [storage]
 * @returns {"auto"|"light"|"dark"} the remembered theme, or "auto".
 */
export function getTheme(storage) {
  return /** @type {"auto"|"light"|"dark"} */ (getPreference("theme", storage));
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
  return getStoredPreference("theme", storage);
}

/**
 * @param {string} theme one of auto, light, dark
 * @param {object} [storage]
 * @returns {boolean} whether it was remembered.
 */
export function setTheme(theme, storage) {
  return setPreference("theme", theme, storage);
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
 * Whether the diagram panel was left open, remembered like the collapse state.
 *
 * Closed is the default, and deliberately so: the diagram is fetched lazily on
 * first open, so a viewer who has never opened the panel costs nothing, and a
 * browser with no storage gets the same quiet start.
 *
 * @param {object} [storage]
 * @returns {boolean}
 */
export function getDiagramOpen(storage) {
  return readRaw(KEY_DIAGRAM_OPEN, storage) === "true";
}

/**
 * A closed panel is removed rather than stored, so a fresh browser and a panel
 * the viewer closed behave the same.
 *
 * @param {boolean} open
 * @param {object} [storage]
 * @returns {boolean} whether it was remembered.
 */
export function setDiagramOpen(open, storage) {
  if (!open) return removeRaw(KEY_DIAGRAM_OPEN, storage);
  return writeRaw(KEY_DIAGRAM_OPEN, "true", storage);
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
