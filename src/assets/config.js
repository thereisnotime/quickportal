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
  embed: false,
  maxFrames: 4,
  diagramTitle: "Diagram",
  diagramMaxBytes: 512 * 1024,
});

/**
 * The default cap on mounted frames, named as in the design so frames.js and
 * this module cannot drift apart. `embedding.maxFrames` overrides it.
 */
export const FRAME_DEFAULT_MAX = DEFAULTS.maxFrames;

/**
 * The largest cap a config may ask for. Each frame is a whole application, so
 * a number past this is far more likely to be a typo than an intention, and it
 * is treated as one: a warning and the default.
 */
export const FRAME_MAX = 16;

/**
 * The default cap on an inlined diagram, named as in the design so diagram.js
 * and this module cannot drift apart. `diagram.maxBytes` overrides it.
 */
export const DIAGRAM_DEFAULT_MAX_BYTES = DEFAULTS.diagramMaxBytes;

/**
 * The largest cap a config may ask for, which is the ConfigMap hard limit.
 *
 * The cap is not arbitrary: the diagram is delivered in the same 1MiB ConfigMap
 * as the config itself, so a cap above that limit describes a file the cluster
 * would refuse to store in the first place. Half of it is the default because
 * the other half has to hold the config, and because inlining a megabyte of SVG
 * makes the page janky on a phone long before the cluster complains.
 */
export const DIAGRAM_MAX_BYTES_LIMIT = 1024 * 1024;

/**
 * Permission tokens accepted in an item's `allow`, which is passed to the
 * frame's `allow` attribute verbatim.
 *
 * Deliberately short, and the only place the set is written down. Anything
 * else is dropped with a warning: a token this portal does not know is either
 * a typo or a browser feature nobody here has thought about, and handing
 * either one to `allow` would delegate a capability by accident. Camera,
 * microphone, geolocation and display-capture are excluded on purpose, since
 * a bookmark list is the wrong place to grant a device to another origin; the
 * ones here are what a dashboard or a media app needs to play and to copy.
 */
export const ALLOW_TOKENS = Object.freeze([
  "autoplay",
  "clipboard-read",
  "clipboard-write",
  "encrypted-media",
  "fullscreen",
  "picture-in-picture",
]);

/**
 * Sandbox tokens accepted in an item's `sandbox`. Same treatment as `allow`:
 * unknown tokens are dropped with a warning rather than reaching the
 * attribute, where a misspelled token silently withholds a capability instead
 * of granting one.
 *
 * `sandbox` is opt-in. Absent or empty means no `sandbox` attribute at all,
 * which is not the same as `sandbox: []` in HTML (that is the most restrictive
 * sandbox there is) and would break every app that was not written for it.
 */
export const SANDBOX_TOKENS = Object.freeze([
  "allow-downloads",
  "allow-forms",
  "allow-modals",
  "allow-popups",
  "allow-popups-to-escape-sandbox",
  "allow-same-origin",
  "allow-scripts",
  "allow-storage-access-by-user-activation",
  "allow-top-navigation-by-user-activation",
]);

const THEMES = ["auto", "light", "dark"];
const DENSITIES = ["comfortable", "compact"];
const TARGETS = ["_blank", "_self"];

const ROOT_KEYS = [
  "version",
  "title",
  "subtitle",
  "theme",
  "layout",
  "reload",
  "embedding",
  "diagram",
  "groups",
  "sets",
];
const LAYOUT_KEYS = ["density", "minCardWidth"];
const RELOAD_KEYS = ["interval"];
const EMBEDDING_KEYS = ["maxFrames", "docsUrl"];
const DIAGRAM_KEYS = ["title", "src", "maxBytes", "renderer", "source"];
const RENDERER_KEYS = ["url", "options"];
const GROUP_KEYS = ["id", "name", "icon", "collapsed", "items", "groups"];
const ITEM_KEYS = [
  "id",
  "name",
  "url",
  "description",
  "icon",
  "tags",
  "target",
  "embed",
  "allow",
  "sandbox",
];
const SET_KEYS = ["id", "name", "icon", "targets"];

// Schemes that would execute code from a bookmark rather than navigate to one.
const BLOCKED_SCHEMES = ["javascript:", "vbscript:"];

// The only schemes a browser will load into a frame. Everything else a
// bookmark may legitimately use -- mailto:, magnet:, tel:, ssh: -- is handed to
// an external handler, so an embedded one could never open.
const FRAMABLE_PROTOCOLS = ["http:", "https:"];

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
    diagram: normalizeDiagram(raw.diagram, ctx),
    groups: normalizeGroups(raw.groups, "groups", [], 1, ctx),
    embedding: null,
    sets: [],
  };
  // After the groups, because it reports which items opted in, and before the
  // sets only so the key order matches the document's.
  config.embedding = normalizeEmbedding(raw.embedding, config, ctx);
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

/**
 * Top level embedding options, plus the summary the view layer needs so it does
 * not have to walk the tree again: `enabled` is true when anything opted in,
 * and `itemIds` lists those items in render order.
 */
function normalizeEmbedding(raw, config, ctx) {
  const itemIds = [];
  for (const item of walkItems(config.groups)) {
    if (item.embed) itemIds.push(item.id);
  }
  const embedding = { maxFrames: DEFAULTS.maxFrames, enabled: itemIds.length > 0, itemIds };

  if (raw === undefined || raw === null) return embedding;
  if (!isPlainObject(raw)) {
    ctx.warnings.push(issue("embedding", `expected a mapping, got ${typeName(raw)}; using defaults`));
    return embedding;
  }
  warnUnknownKeys(raw, EMBEDDING_KEYS, "embedding", ctx);
  readDocsUrl(raw, embedding, ctx);

  const max = raw.maxFrames;
  if (max === undefined || max === null) return embedding;
  if (typeof max !== "number" || !Number.isInteger(max) || max < 1 || max > FRAME_MAX) {
    ctx.warnings.push(
      issue(
        "embedding.maxFrames",
        `expected a whole number of frames between 1 and ${FRAME_MAX}, got ${JSON.stringify(max)}; ` +
          `using ${DEFAULTS.maxFrames}`,
      ),
    );
    return embedding;
  }
  embedding.maxFrames = max;
  return embedding;
}

/**
 * Where "why can a frame stay blank" points.
 *
 * The page cannot link to this repository's own documentation: the served tree
 * is a flat ConfigMap with no docs in it, and there is no host to hardcode. So
 * the escape-hatch bar states the headers inline, and this optional key lets a
 * deployment point at its own runbook instead.
 */
function readDocsUrl(raw, embedding, ctx) {
  const url = raw.docsUrl;
  if (url === undefined || url === null) return;
  if (typeof url !== "string" || !isUsableUrl(url)) {
    ctx.warnings.push(
      issue("embedding.docsUrl", `expected a URL, got ${JSON.stringify(url)}; no documentation link is shown`),
    );
    return;
  }
  embedding.docsUrl = url;
}

// ---------------------------------------------------------------------------
// Diagram
// ---------------------------------------------------------------------------

/**
 * Normalize the optional `diagram` section.
 *
 * Null means "no diagram", which is exactly what the view layer needs to know
 * to render no panel and fetch nothing: there is never a half-configured object
 * to inspect, and a config without the section behaves as it did before the
 * section existed.
 *
 * When a diagram is configured the result is complete, including `mode`, so the
 * panel does not have to work out which of the two ways in applies:
 *
 *   {title, src, maxBytes, renderer: {url, options}|null, source, mode}
 *
 * `mode` is "src" for a pre-rendered SVG and "renderer" for source rendered in
 * the page. There are only those two, because a section that configures neither
 * cannot show anything and is reported as an error instead.
 */
function normalizeDiagram(raw, ctx) {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) {
    ctx.warnings.push(
      issue("diagram", `expected a mapping, got ${typeName(raw)}; no diagram is shown`),
    );
    return null;
  }
  warnUnknownKeys(raw, DIAGRAM_KEYS, "diagram", ctx);

  // Counted so the "nothing to show" error below is only reported when nothing
  // more specific has been said already. Telling an author their renderer URL
  // is unsafe *and* that they configured no diagram is noise.
  const errorsBefore = ctx.errors.length;

  const diagram = {
    title: readDiagramTitle(raw.title, ctx),
    src: readDiagramSrc(raw.src, ctx),
    maxBytes: readDiagramMaxBytes(raw.maxBytes, ctx),
    renderer: null,
    source: null,
    mode: null,
  };

  const renderer = readRenderer(raw.renderer, ctx);
  const source = readDiagramSource(raw.source, ctx);

  // A renderer and its source only mean anything together. Either one alone is
  // a misconfiguration worth saying out loud: a renderer with nothing to render
  // imports a module for no reason, and source with no renderer is a diagram
  // the portal has no way to draw. Both are reported against the missing half,
  // and neither is reported when that half was present but itself broken, since
  // readRenderer and readDiagramSource have already said so.
  if (renderer && source === null && raw.source === undefined) {
    ctx.errors.push(
      issue(
        "diagram.source",
        "a renderer is configured but no source is given; add diagram.source, or drop the " +
          "renderer and point diagram.src at a pre-rendered SVG",
      ),
    );
  }
  if (source !== null && renderer === null && raw.renderer === undefined) {
    ctx.errors.push(
      issue(
        "diagram.renderer",
        "diagram source is given but no renderer is configured to turn it into SVG; add " +
          "diagram.renderer.url, or render it to SVG yourself and point diagram.src at the result",
      ),
    );
  }
  if (renderer && source !== null) {
    diagram.renderer = renderer;
    diagram.source = source;
  }

  // Both together is a supported and useful combination, not a conflict: the
  // renderer draws the diagram, and src is the fallback shown when the renderer
  // cannot be reached. That is what an operator on a laptop with no route to
  // their CDN gets instead of an apology, so neither is dropped and there is
  // nothing to warn about.
  if (diagram.renderer !== null) {
    diagram.mode = "renderer";
  } else if (diagram.src !== null) {
    diagram.mode = "src";
  } else {
    if (ctx.errors.length === errorsBefore) {
      ctx.errors.push(
        issue(
          "diagram.src",
          "a diagram needs either src naming a pre-rendered SVG, or a renderer and the source " +
            "to render; this section configures neither, so there is nothing to show",
        ),
      );
    }
    return null;
  }

  return diagram;
}

function readDiagramTitle(value, ctx) {
  const title = optionalString(value, "diagram.title", DEFAULTS.diagramTitle, ctx);
  // An empty or blank heading would leave the panel's label pointing at nothing,
  // so it falls back the same way a missing one does.
  return isNonEmptyString(title) ? title.trim() : DEFAULTS.diagramTitle;
}

// The served path of the SVG. An absolute URL is permitted but is not the
// documented default, because it needs the deployment's img-src/connect-src
// widened; a scheme that executes rather than fetches is refused outright.
function readDiagramSrc(value, ctx) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    ctx.errors.push(
      issue("diagram.src", `src must be the path of an SVG file, got ${typeName(value)}`),
    );
    return null;
  }
  const src = value.trim();
  const lower = src.toLowerCase();
  if (BLOCKED_SCHEMES.some((scheme) => lower.startsWith(scheme))) {
    ctx.errors.push(issue("diagram.src", `${src.split(":")[0]}: URLs are not allowed as a diagram src`));
    return null;
  }
  if (!isUsableUrl(src)) {
    ctx.errors.push(issue("diagram.src", `"${src}" is not a path or URL`));
    return null;
  }
  return src;
}

function readDiagramMaxBytes(value, ctx) {
  if (value === undefined || value === null) return DIAGRAM_DEFAULT_MAX_BYTES;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > DIAGRAM_MAX_BYTES_LIMIT
  ) {
    ctx.warnings.push(
      issue(
        "diagram.maxBytes",
        `expected a whole number of bytes between 1 and ${DIAGRAM_MAX_BYTES_LIMIT}, which is what ` +
          `a ConfigMap can hold, got ${JSON.stringify(value)}; using ${DIAGRAM_DEFAULT_MAX_BYTES}`,
      ),
    );
    return DIAGRAM_DEFAULT_MAX_BYTES;
  }
  return value;
}

function readDiagramSource(value, ctx) {
  if (value === undefined || value === null) return null;
  if (!isNonEmptyString(value)) {
    ctx.errors.push(
      issue("diagram.source", `expected the diagram source as text, got ${typeName(value)}`),
    );
    return null;
  }
  // Not trimmed: the source is handed to the renderer as written, and for a
  // whitespace-sensitive diagram language the indentation is the diagram.
  return value;
}

function readRenderer(raw, ctx) {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) {
    ctx.warnings.push(
      issue(
        "diagram.renderer",
        `expected a mapping with a url, got ${typeName(raw)}; no renderer is used`,
      ),
    );
    return null;
  }
  warnUnknownKeys(raw, RENDERER_KEYS, "diagram.renderer", ctx);

  const url = raw.url;
  if (url === undefined || url === null || url === "") {
    ctx.errors.push(
      issue("diagram.renderer.url", "a renderer needs a url naming the module to import"),
    );
    return null;
  }
  if (!isSafeRendererUrl(url)) {
    ctx.errors.push(
      issue(
        "diagram.renderer.url",
        `${JSON.stringify(url)} is not a renderer this portal will import: the url must be an ` +
          "absolute https:// URL or a same-origin path. http:// is refused because the module " +
          "would arrive over a channel anyone on the path can rewrite, a protocol-relative URL " +
          "because it inherits whichever scheme the page happens to have, and data:, blob: and " +
          "javascript: because they smuggle the code itself into the config",
      ),
    );
    return null;
  }

  return { url: String(url).trim(), options: readRendererOptions(raw.options, ctx) };
}

/**
 * The renderer's own options, passed through verbatim.
 *
 * Nothing here inspects the contents: these are the operator's settings for a
 * renderer this portal has never seen, so an allowlist could only break a
 * renderer it has not heard of while protecting nothing -- the renderer's output
 * goes through the sanitiser regardless of what it was told. The shape is still
 * checked, because handing a renderer a string where it expects an object is a
 * failure with no useful message.
 *
 * `securityLevel` is the one option worth documenting: a renderer told to trust
 * its input will happily emit things the sanitiser then removes.
 */
function readRendererOptions(value, ctx) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) {
    ctx.warnings.push(
      issue(
        "diagram.renderer.options",
        `expected a mapping of renderer options, got ${typeName(value)}; ignored`,
      ),
    );
    return null;
  }
  return value;
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

  const embedding = readEmbedFields(raw, path, url, ctx);
  if (embedding === null) return null;

  return {
    id,
    name,
    url,
    description: optionalString(raw.description, `${path}.description`, "", ctx),
    icon: optionalIcon(raw.icon, `${path}.icon`, ctx),
    tags: normalizeTags(raw.tags, `${path}.tags`, ctx),
    target: optionalEnum(raw.target, TARGETS, `${path}.target`, DEFAULTS.target, ctx),
    embed: embedding.embed,
    allow: embedding.allow,
    sandbox: embedding.sandbox,
  };
}

// `embed`, `allow` and `sandbox` for one item. Returns null when the item
// cannot stand, which is the same contract as the rest of normalizeItem:
// an error drops the entry rather than rendering something that cannot work.
function readEmbedFields(raw, path, url, ctx) {
  const embed = optionalBoolean(raw.embed, `${path}.embed`, DEFAULTS.embed, ctx);
  const allow = normalizeTokenList(raw.allow, `${path}.allow`, ALLOW_TOKENS, "permission", ctx);
  const sandbox = normalizeTokenList(raw.sandbox, `${path}.sandbox`, SANDBOX_TOKENS, "sandbox", ctx);

  // A scheme that cannot be framed makes the embed request impossible, not the
  // bookmark. Dropping the entry would cost the author a working link over a
  // field that can simply be ignored, so this degrades: the item stays, opens
  // in a browser tab, and the author is told why.
  if (embed && !isFramableUrl(url)) {
    const scheme = url.split(":")[0];
    ctx.warnings.push(
      issue(
        `${path}.embed`,
        `${scheme}: URLs cannot be framed, so this item opens in a browser tab; ` +
          `remove "embed: true" to silence this`,
      ),
    );
    return { embed: false, allow, sandbox };
  }

  if (!embed && (allow.length > 0 || sandbox.length > 0)) {
    ctx.warnings.push(
      issue(path, 'allow and sandbox only apply to an embedded item; add "embed: true" or drop them'),
    );
  }

  // The combination is honoured, because withholding a token an operator asked
  // for would break their app in a way that is hard to trace back to here, but
  // it is never honoured quietly: a framed page allowed both can reach into its
  // own sandbox attribute and remove it, so the sandbox protects nothing.
  if (sandbox.includes("allow-scripts") && sandbox.includes("allow-same-origin")) {
    ctx.warnings.push(
      issue(
        `${path}.sandbox`,
        "allow-scripts together with allow-same-origin lets the framed page remove its own " +
          "sandbox, so this combination provides no protection; drop one of the two",
      ),
    );
  }

  return { embed, allow, sandbox };
}

// One token list, filtered against a known set. Unknown tokens are named and
// dropped: see ALLOW_TOKENS for why nothing is passed through unrecognised.
function normalizeTokenList(value, path, allowed, kind, ctx) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    ctx.warnings.push(issue(path, `expected a list of ${kind} tokens, got ${typeName(value)}; ignored`));
    return [];
  }
  const tokens = [];
  value.forEach((token, index) => {
    if (!isNonEmptyString(token)) {
      ctx.warnings.push(
        issue(`${path}[${index}]`, `expected a ${kind} token, got ${typeName(token)}; ignored`),
      );
      return;
    }
    const name = token.trim();
    if (!allowed.includes(name)) {
      ctx.warnings.push(
        issue(
          `${path}[${index}]`,
          `unknown ${kind} token "${name}" dropped; this portal passes through only ` +
            `${allowed.join(", ")}`,
        ),
      );
      return;
    }
    if (!tokens.includes(name)) tokens.push(name);
  });
  return tokens;
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

/**
 * True for a URL a browser will load into a frame: `http(s)`, or a relative URL,
 * which resolves against the page's own origin.
 *
 * Built on isUsableUrl and its base URL rather than a second scheme list, so a
 * relative URL is classified the same way in both and only the scheme of an
 * absolute URL decides the answer.
 */
export function isFramableUrl(value) {
  if (!isUsableUrl(value)) return false;
  const { protocol } = new URL(String(value).trim(), "http://example.com/");
  return FRAMABLE_PROTOCOLS.includes(protocol);
}

/**
 * True for a URL the page may `import()` as a diagram renderer.
 *
 * THIS IS THE MOST SECURITY-RELEVANT FIELD IN THE WHOLE CONFIG. Every other URL
 * here is navigated to, framed or fetched; this one names code that runs inside
 * the page, with the page's origin, its storage and its DOM. So it is validated
 * narrowly, by what is permitted rather than by what is known to be bad:
 *
 *   - an absolute `https://` URL, so the module cannot be rewritten in transit
 *     by anyone on the network path, and
 *   - a relative path, which resolves against the page's own origin and so
 *     names something the deployment already serves.
 *
 * Everything else is refused, including the cases that look harmless:
 * `http://` (rewritable in transit), `//host/mod.mjs` (protocol-relative, so it
 * inherits whichever scheme the page has and silently becomes the http case on
 * a plain-http deployment), and `data:`, `blob:` and `javascript:`, which carry
 * the code in the config itself and would turn a config edit into code
 * execution with no origin to add to `script-src` and nothing for an operator
 * to review. A backslash is refused because URL parsers disagree about whether
 * it separates a path, which is how `/\host/mod.mjs` becomes a host.
 *
 * The CSP is still the enforcement point -- the import fails unless the
 * deployment lists the origin in `script-src` -- but the config must not be the
 * place where a bad origin gets in unremarked.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSafeRendererUrl(value) {
  if (!isNonEmptyString(value)) return false;
  const candidate = value.trim();
  if (/[\s\u0000-\u001f\\]/.test(candidate)) return false;
  // Protocol-relative, checked before the scheme test, which it would pass by
  // having no scheme at all.
  if (candidate.startsWith("//")) return false;

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate)) {
    let url;
    try {
      url = new URL(candidate);
    } catch {
      return false;
    }
    return url.protocol === "https:" && url.host !== "";
  }

  // No scheme, so it is relative and resolves against the page's own origin.
  // The base is a reserved example domain and never contacted.
  try {
    new URL(candidate, "https://example.com/");
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
