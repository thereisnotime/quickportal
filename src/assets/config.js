// Config parsing, normalization and validation for QuickPortal.
//
// This module is deliberately free of DOM and storage access so that it can be
// imported and tested in plain Node, and reused by tools/validate-config.mjs.
//
// Every problem is reported as an issue: {path, message}, where path looks like
// "groups[0].items[2].url". Errors mean "do not render the tree"; warnings mean
// "render anyway, but tell the author".

// The vendored YAML parser sits next to this file in both trees: flat when
// served (see design: "Served layout"), and in the same directory in the
// repository, which is why one static import works for both. A JSON-only config
// never reaches it.
import { load as vendoredYamlLoad } from "./js-yaml.mjs";

/** The schema version this portal implements. */
export const CONFIG_VERSION = 1;

/** Groups nested deeper than this are dropped with a warning. */
export const MAX_DEPTH = 5;

/** Path used for issues about the document as a whole. */
export const ROOT_PATH = "config";

export const DEFAULTS = Object.freeze({
  title: "QuickPortal",
  subtitle: "",
  theme: "auto",
  density: "comfortable",
  minCardWidth: "14rem",
  reloadInterval: 30,
  target: "_blank",
  collapsed: false,
});

const THEMES = ["auto", "light", "dark"];
const DENSITIES = ["comfortable", "compact"];
const TARGETS = ["_blank", "_self"];

const ROOT_KEYS = ["version", "title", "subtitle", "theme", "layout", "reload", "groups", "sets"];
const LAYOUT_KEYS = ["density", "minCardWidth"];
const RELOAD_KEYS = ["interval"];
const GROUP_KEYS = ["id", "name", "icon", "collapsed", "items", "groups"];
const ITEM_KEYS = ["id", "name", "url", "description", "icon", "tags", "target"];
const SET_KEYS = ["id", "name", "icon", "targets"];

// Schemes that would execute code from a bookmark rather than navigate to one.
const BLOCKED_SCHEMES = ["javascript:", "vbscript:"];

function issue(path, message) {
  return { path, message };
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

// ---------------------------------------------------------------------------
// parseConfig
// ---------------------------------------------------------------------------

/**
 * Parse config text as JSON, falling back to YAML.
 *
 * @param {string} text
 * @param {{yamlLoad?: (text: string) => unknown}} [options] test seam; defaults
 *        to the vendored js-yaml.
 * @returns {{raw: unknown, errors: Array<{path: string, message: string}>}}
 */
export function parseConfig(text, options = {}) {
  const yamlLoad = options.yamlLoad || vendoredYamlLoad;

  if (typeof text !== "string") {
    return { raw: null, errors: [issue(ROOT_PATH, "config must be text")] };
  }
  if (text.trim() === "") {
    return { raw: null, errors: [issue(ROOT_PATH, "config file is empty")] };
  }

  try {
    return { raw: JSON.parse(text), errors: [] };
  } catch {
    // Not JSON. YAML is the richer syntax, so its error is the useful one.
  }

  if (typeof yamlLoad !== "function") {
    return {
      raw: null,
      errors: [issue(ROOT_PATH, "config is not valid JSON and no YAML parser is available")],
    };
  }

  try {
    return { raw: yamlLoad(text), errors: [] };
  } catch (error) {
    return { raw: null, errors: [issue(ROOT_PATH, formatYamlError(error))] };
  }
}

// js-yaml marks are zero-based; humans and editors count from one.
function formatYamlError(error) {
  const reason = (error && (error.reason || error.message)) || "unknown parse error";
  const mark = error && error.mark;
  if (!mark || typeof mark.line !== "number") {
    return `YAML parse error: ${reason}`;
  }
  const line = mark.line + 1;
  const column = typeof mark.column === "number" ? mark.column + 1 : null;
  const where = column === null ? `line ${line}` : `line ${line}, column ${column}`;
  return `YAML parse error at ${where}: ${reason}`;
}

// ---------------------------------------------------------------------------
// normalizeConfig
// ---------------------------------------------------------------------------

/**
 * Apply defaults, derive ids, validate, and report issues.
 *
 * `config` is null when the document is unusable as a whole (not a mapping, or
 * a version this portal does not implement); otherwise it is a complete config
 * object even when errors are present, so a caller may still inspect it.
 *
 * @param {unknown} raw
 * @returns {{config: object|null, errors: Array<object>, warnings: Array<object>}}
 */
export function normalizeConfig(raw) {
  const ctx = { errors: [], warnings: [], idPaths: new Map(), setIdPaths: new Map() };

  if (!isPlainObject(raw)) {
    ctx.errors.push(issue(ROOT_PATH, "config must be a mapping of keys to values"));
    return { config: null, errors: ctx.errors, warnings: ctx.warnings };
  }

  const versionError = checkVersion(raw.version);
  if (versionError) {
    ctx.errors.push(versionError);
    return { config: null, errors: ctx.errors, warnings: ctx.warnings };
  }

  warnUnknownKeys(raw, ROOT_KEYS, "", ctx);

  const config = {
    version: raw.version,
    title: optionalString(raw.title, "title", DEFAULTS.title, ctx),
    subtitle: optionalString(raw.subtitle, "subtitle", DEFAULTS.subtitle, ctx),
    theme: optionalEnum(raw.theme, THEMES, "theme", DEFAULTS.theme, ctx),
    layout: normalizeLayout(raw.layout, ctx),
    reload: normalizeReload(raw.reload, ctx),
    groups: normalizeGroups(raw.groups, "groups", [], 1, ctx),
    sets: [],
  };
  config.sets = normalizeSets(raw.sets, config, ctx);

  return { config, errors: ctx.errors, warnings: ctx.warnings };
}

function checkVersion(version) {
  if (version === undefined || version === null) {
    return issue("version", `version is required; add "version: ${CONFIG_VERSION}"`);
  }
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return issue("version", `version must be a whole number, got ${JSON.stringify(version)}`);
  }
  if (version > CONFIG_VERSION) {
    return issue(
      "version",
      `this config declares version ${version}, but this portal implements version ` +
        `${CONFIG_VERSION}; upgrade QuickPortal to use it`,
    );
  }
  if (version < 1) {
    return issue("version", `version ${version} is not a known schema version`);
  }
  return null;
}

function warnUnknownKeys(object, knownKeys, parentPath, ctx) {
  for (const key of Object.keys(object)) {
    if (knownKeys.includes(key)) continue;
    const path = parentPath === "" ? key : `${parentPath}.${key}`;
    ctx.warnings.push(issue(path, `unknown key "${key}" ignored`));
  }
}

function optionalString(value, path, fallback, ctx) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string") return value;
  ctx.warnings.push(issue(path, `expected text, got ${typeName(value)}; using the default`));
  return fallback;
}

function optionalEnum(value, allowed, path, fallback, ctx) {
  if (value === undefined || value === null) return fallback;
  if (allowed.includes(value)) return value;
  ctx.warnings.push(
    issue(path, `expected one of ${allowed.join(", ")}, got ${JSON.stringify(value)}; using "${fallback}"`),
  );
  return fallback;
}

function typeName(value) {
  if (Array.isArray(value)) return "a list";
  if (value === null) return "null";
  if (isPlainObject(value)) return "a mapping";
  return `a ${typeof value}`;
}

function normalizeLayout(raw, ctx) {
  const layout = { density: DEFAULTS.density, minCardWidth: DEFAULTS.minCardWidth };
  if (raw === undefined || raw === null) return layout;
  if (!isPlainObject(raw)) {
    ctx.warnings.push(issue("layout", `expected a mapping, got ${typeName(raw)}; using defaults`));
    return layout;
  }
  warnUnknownKeys(raw, LAYOUT_KEYS, "layout", ctx);
  layout.density = optionalEnum(raw.density, DENSITIES, "layout.density", DEFAULTS.density, ctx);
  layout.minCardWidth = optionalString(
    raw.minCardWidth,
    "layout.minCardWidth",
    DEFAULTS.minCardWidth,
    ctx,
  );
  return layout;
}

function normalizeReload(raw, ctx) {
  const reload = { interval: DEFAULTS.reloadInterval };
  if (raw === undefined || raw === null) return reload;
  if (!isPlainObject(raw)) {
    ctx.warnings.push(issue("reload", `expected a mapping, got ${typeName(raw)}; using defaults`));
    return reload;
  }
  warnUnknownKeys(raw, RELOAD_KEYS, "reload", ctx);
  if (raw.interval === undefined || raw.interval === null) return reload;
  if (typeof raw.interval !== "number" || !Number.isFinite(raw.interval) || raw.interval < 0) {
    ctx.warnings.push(
      issue(
        "reload.interval",
        `expected a number of seconds (0 disables reloading), got ${JSON.stringify(raw.interval)}; ` +
          `using ${DEFAULTS.reloadInterval}`,
      ),
    );
    return reload;
  }
  reload.interval = raw.interval;
  return reload;
}

// ---------------------------------------------------------------------------
// Groups and items
// ---------------------------------------------------------------------------

function normalizeGroups(raw, path, parentIds, depth, ctx) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    ctx.errors.push(issue(path, `expected a list of groups, got ${typeName(raw)}`));
    return [];
  }
  const groups = [];
  raw.forEach((entry, index) => {
    const group = normalizeGroup(entry, `${path}[${index}]`, parentIds, depth, index, ctx);
    if (group) groups.push(group);
  });
  return groups;
}

function normalizeGroup(raw, path, parentIds, depth, index, ctx) {
  if (!isPlainObject(raw)) {
    ctx.errors.push(issue(path, `expected a mapping describing a group, got ${typeName(raw)}`));
    return null;
  }
  warnUnknownKeys(raw, GROUP_KEYS, path, ctx);

  const name = readName(raw, path, "group", ctx);
  if (name === null) return null;

  const id = resolveId(raw, path, name, parentIds, `group-${index}`, ctx, ctx.idPaths);
  if (id === null) return null;

  // The parent's id is already the whole qualified path, so it is the only
  // prefix a child needs. Appending it to the inherited list instead would
  // join the chain twice and produce media/media/downloads/deeper at depth 3.
  const childIds = [id];
  const group = {
    id,
    name,
    icon: optionalIcon(raw.icon, `${path}.icon`, ctx),
    collapsed: optionalBoolean(raw.collapsed, `${path}.collapsed`, DEFAULTS.collapsed, ctx),
    items: normalizeItems(raw.items, `${path}.items`, childIds, ctx),
    groups: [],
  };

  const hasChildGroups = Array.isArray(raw.groups) && raw.groups.length > 0;
  if (depth >= MAX_DEPTH && hasChildGroups) {
    ctx.warnings.push(
      issue(
        `${path}.groups`,
        `nesting deeper than ${MAX_DEPTH} levels is not supported; the tree is truncated here`,
      ),
    );
  } else {
    group.groups = normalizeGroups(raw.groups, `${path}.groups`, childIds, depth + 1, ctx);
  }

  return group;
}

function normalizeItems(raw, path, parentIds, ctx) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    ctx.errors.push(issue(path, `expected a list of items, got ${typeName(raw)}`));
    return [];
  }
  const items = [];
  raw.forEach((entry, index) => {
    const item = normalizeItem(entry, `${path}[${index}]`, parentIds, index, ctx);
    if (item) items.push(item);
  });
  return items;
}

function normalizeItem(raw, path, parentIds, index, ctx) {
  if (!isPlainObject(raw)) {
    ctx.errors.push(issue(path, `expected a mapping describing an item, got ${typeName(raw)}`));
    return null;
  }
  warnUnknownKeys(raw, ITEM_KEYS, path, ctx);

  const name = readName(raw, path, "item", ctx);
  if (name === null) return null;

  const url = readUrl(raw.url, `${path}.url`, ctx);
  if (url === null) return null;

  const id = resolveId(raw, path, name, parentIds, `item-${index}`, ctx, ctx.idPaths);
  if (id === null) return null;

  return {
    id,
    name,
    url,
    description: optionalString(raw.description, `${path}.description`, "", ctx),
    icon: optionalIcon(raw.icon, `${path}.icon`, ctx),
    tags: normalizeTags(raw.tags, `${path}.tags`, ctx),
    target: optionalEnum(raw.target, TARGETS, `${path}.target`, DEFAULTS.target, ctx),
  };
}

function readName(raw, path, kind, ctx) {
  if (isNonEmptyString(raw.name)) return raw.name.trim();
  if (isNonEmptyString(raw.id)) {
    ctx.warnings.push(issue(`${path}.name`, `no name; showing the id "${raw.id.trim()}" instead`));
    return raw.id.trim();
  }
  ctx.errors.push(issue(`${path}.name`, `every ${kind} needs a name (or an id to show instead)`));
  return null;
}

function optionalBoolean(value, path, fallback, ctx) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  ctx.warnings.push(issue(path, `expected true or false, got ${typeName(value)}; using ${fallback}`));
  return fallback;
}

function optionalIcon(value, path, ctx) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  ctx.warnings.push(issue(path, `expected text, a URL or "auto", got ${typeName(value)}; ignored`));
  return null;
}

function normalizeTags(value, path, ctx) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    ctx.warnings.push(issue(path, `expected a list of tags, got ${typeName(value)}; ignored`));
    return [];
  }
  const tags = [];
  value.forEach((tag, index) => {
    if (isNonEmptyString(tag)) {
      tags.push(tag.trim());
      return;
    }
    ctx.warnings.push(issue(`${path}[${index}]`, `expected a tag name, got ${typeName(tag)}; ignored`));
  });
  return tags;
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/**
 * Turn a name into an id fragment: lowercase, with every run of other
 * characters collapsed to a single hyphen.
 */
export function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Explicit ids are global; derived ids are qualified by the chain of ancestor
// ids, so two groups may each hold an item named "Status" without colliding.
// The result only depends on the config itself, so it survives a reload.
function resolveId(raw, path, name, parentIds, positionalFallback, ctx, idPaths) {
  let id;
  if (raw.id !== undefined && raw.id !== null) {
    if (!isNonEmptyString(raw.id) || /\s/.test(raw.id)) {
      ctx.errors.push(issue(`${path}.id`, "id must be text without spaces"));
      return null;
    }
    id = raw.id.trim();
  } else {
    const slug = slugify(name) || positionalFallback;
    id = [...parentIds, slug].join("/");
  }

  const existingPath = idPaths.get(id);
  if (existingPath !== undefined) {
    ctx.errors.push(
      issue(path, `duplicate id "${id}": already used by ${existingPath}; give one of them its own id`),
    );
    return null;
  }
  idPaths.set(id, path);
  return id;
}

// ---------------------------------------------------------------------------
// Sets
// ---------------------------------------------------------------------------

function normalizeSets(raw, config, ctx) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    ctx.errors.push(issue("sets", `expected a list of sets, got ${typeName(raw)}`));
    return [];
  }
  const sets = [];
  raw.forEach((entry, index) => {
    const set = normalizeSet(entry, `sets[${index}]`, index, ctx);
    if (set) sets.push(set);
  });

  // Targets can only be checked once every id in the tree is known.
  sets.forEach((set) => reportUnresolvedTargets(set, config, ctx));
  return sets;
}

function normalizeSet(raw, path, index, ctx) {
  if (!isPlainObject(raw)) {
    ctx.errors.push(issue(path, `expected a mapping describing a set, got ${typeName(raw)}`));
    return null;
  }
  warnUnknownKeys(raw, SET_KEYS, path, ctx);

  const name = readName(raw, path, "set", ctx);
  if (name === null) return null;

  const id = resolveId(raw, path, name, [], `set-${index}`, ctx, ctx.setIdPaths);
  if (id === null) return null;

  const targets = normalizeTargets(raw.targets, `${path}.targets`, ctx);
  return { id, name, icon: optionalIcon(raw.icon, `${path}.icon`, ctx), targets, path };
}

function normalizeTargets(value, path, ctx) {
  if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) {
    ctx.errors.push(issue(path, "a set needs at least one target"));
    return [];
  }
  if (!Array.isArray(value)) {
    ctx.errors.push(issue(path, `expected a list of ids or URLs, got ${typeName(value)}`));
    return [];
  }
  const targets = [];
  value.forEach((target, index) => {
    if (isNonEmptyString(target)) {
      targets.push(target.trim());
      return;
    }
    ctx.errors.push(issue(`${path}[${index}]`, `expected an id or a URL, got ${typeName(target)}`));
  });
  return targets;
}

function reportUnresolvedTargets(set, config, ctx) {
  const { unresolved } = resolveTargets(set, config);
  for (const target of unresolved) {
    const index = set.targets.indexOf(target);
    const path = index === -1 ? `${set.path}.targets` : `${set.path}.targets[${index}]`;
    ctx.errors.push(
      issue(path, `set "${set.name}" lists "${target}", which is not an id in this config or a URL`),
    );
  }
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/**
 * True for anything a browser can navigate to: an absolute URL in any scheme,
 * or a relative URL. False for text that is simply not a URL.
 */
export function isUsableUrl(value) {
  if (!isNonEmptyString(value)) return false;
  const candidate = value.trim();
  if (/[\s\u0000-\u001f]/.test(candidate)) return false;
  try {
    // A base makes relative URLs ("/grafana", "./status") parse too. The base is
    // a reserved example domain and never contacted.
    new URL(candidate, "http://example.com/");
    return true;
  } catch {
    return false;
  }
}

function readUrl(value, path, ctx) {
  if (value === undefined || value === null || value === "") {
    ctx.errors.push(issue(path, "url is required"));
    return null;
  }
  if (typeof value !== "string") {
    ctx.errors.push(issue(path, `url must be text, got ${typeName(value)}`));
    return null;
  }
  const url = value.trim();
  const lower = url.toLowerCase();
  if (BLOCKED_SCHEMES.some((scheme) => lower.startsWith(scheme))) {
    ctx.errors.push(issue(path, `${url.split(":")[0]}: URLs are not allowed as bookmarks`));
    return null;
  }
  if (!isUsableUrl(url)) {
    ctx.errors.push(issue(path, `"${url}" is not a URL`));
    return null;
  }
  return url;
}

// A target is a URL rather than an id when it carries a scheme or is rooted, so
// a mistyped id stays a mistyped id instead of becoming a relative link.
function targetLooksLikeUrl(target) {
  if (target.startsWith("/")) return true;
  try {
    new URL(target);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/**
 * Map every item in the config by id, depth-first in config order.
 *
 * @param {object} config a normalized config
 * @returns {Map<string, object>}
 */
export function indexItems(config) {
  const index = new Map();
  for (const item of walkItems(config && config.groups)) {
    if (!index.has(item.id)) index.set(item.id, item);
  }
  return index;
}

function* walkGroups(groups) {
  for (const group of groups || []) {
    yield group;
    yield* walkGroups(group.groups);
  }
}

// Items of a group come before the items of its subgroups, matching the order
// the page renders them in.
function* walkItems(groups) {
  for (const group of groups || []) {
    yield* group.items || [];
    yield* walkItems(group.groups);
  }
}

function indexGroups(config) {
  const index = new Map();
  for (const group of walkGroups(config && config.groups)) {
    if (!index.has(group.id)) index.set(group.id, group);
  }
  return index;
}

/**
 * Resolve a set's targets to items.
 *
 * A target is an item id, a group id (every item beneath it, depth-first in
 * config order), or a bare URL. A bare URL becomes a synthetic item so callers
 * can treat the result uniformly. Targets that resolve to the same URL are
 * returned once.
 *
 * @param {{targets?: string[]}} set
 * @param {object} config a normalized config
 * @returns {{items: object[], unresolved: string[]}}
 */
export function resolveTargets(set, config) {
  const items = new Map(); // url -> item, which also de-duplicates
  const unresolved = [];
  const itemIndex = indexItems(config);
  const groupIndex = indexGroups(config);

  for (const target of (set && set.targets) || []) {
    const item = itemIndex.get(target);
    if (item) {
      addTarget(items, item);
      continue;
    }

    const group = groupIndex.get(target);
    if (group) {
      for (const beneath of walkItems([group])) addTarget(items, beneath);
      continue;
    }

    if (targetLooksLikeUrl(target)) {
      addTarget(items, { id: null, name: target, url: target, synthetic: true });
      continue;
    }

    if (!unresolved.includes(target)) unresolved.push(target);
  }

  return { items: [...items.values()], unresolved };
}

function addTarget(items, item) {
  if (!items.has(item.url)) items.set(item.url, item);
}
