/**
 * render.js - everything that touches the DOM inside the portal root.
 *
 * Public surface (the contract in design.md):
 *   renderPortal(root, config, handlers)
 *   renderIssues(root, errors, warnings)
 *   applyFilter(root, query) -> matchCount
 *   renderTabStrip(strip, model, handlers)   the strip of embedded apps
 *   renderFrameNudge(frameHost, model, handlers)   the escape hatch
 * Plus two helpers app.js needs: renderNotice(root, notice) to report set
 * results, and setCollapsedAll(root, collapsed) for expand-all/collapse-all.
 *
 * The strip is rendered from the frame host's change list and nothing else.
 * This module never creates, moves or removes a frame element: moving an
 * <iframe> in the DOM reloads it, which would throw away whatever the user had
 * open inside an embedded app. #frame-host and its children belong to
 * frames.js; the only things rendered here are the strip, its controls and the
 * nudge bar, all of them outside the frame host.
 *
 * Two rules shape the implementation:
 *  - No inline script, style attribute or event handler anywhere: the page is
 *    served under `script-src 'self'; style-src 'self'`. Behaviour is bound
 *    with addEventListener, appearance with classes and data-* attributes.
 *  - A re-render must not disturb the user, because reload.js calls it while
 *    they are mid-task. So nodes are reconciled by key and updated in place
 *    rather than rebuilt from innerHTML, which keeps focus, scroll and loaded
 *    icons intact.
 */

import { isCollapsed } from "./state.js";

/** Collapse decisions made in this page view, so toggling still works when
 *  localStorage is blocked and state.js cannot persist anything. */
const sessionCollapse = new Map();

/** Collapse state as it was before a search started filtering, so clearing the
 *  query restores the tree the user left behind. */
const preFilterCollapse = new Map();

/** The item object behind a card element, for handlers.onOpenItem. */
const itemForElement = new WeakMap();

/** Roots whose delegated listeners are already attached. */
const boundRoots = new WeakMap();

const CSS_LENGTH = /^\d+(?:\.\d+)?(?:rem|em|px|ch|vw|%)$/;
const URL_ICON = /^(?:https?:\/\/|data:image\/|\.?\/)/i;

/* -------------------------------------------------------------------------
 * Tiny DOM helpers. Every write is conditional so that re-rendering an
 * unchanged config touches nothing.
 * ---------------------------------------------------------------------- */

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function setText(node, text) {
  const value = text == null ? "" : String(text);
  if (node.textContent !== value) node.textContent = value;
}

function setAttr(node, name, value) {
  if (value == null || value === false) {
    if (node.hasAttribute(name)) node.removeAttribute(name);
    return;
  }
  const next = String(value);
  if (node.getAttribute(name) !== next) node.setAttribute(name, next);
}

function setHidden(node, hidden) {
  if (!node) return;
  if (node.hidden !== hidden) node.hidden = hidden;
}

/** A DOM id fragment that is safe for aria-controls / aria-labelledby. */
function domSafe(value) {
  return String(value == null ? "" : value).replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * Keyed reconcile of one container's children. `specs` carry a stable `key`;
 * existing elements with a matching data-key are reused and reordered, the
 * rest are created, leftovers are removed.
 */
function reconcile(parent, specs, build, update) {
  const existing = new Map();
  for (const child of Array.from(parent.children)) {
    const key = child.dataset ? child.dataset.key : null;
    if (key) existing.set(key, child);
    else child.remove(); // transient nodes (empty states, no-match panels)
  }

  let index = 0;
  for (const spec of specs) {
    let node = existing.get(spec.key);
    if (node) {
      existing.delete(spec.key);
    } else {
      node = build(spec);
      node.dataset.key = spec.key;
    }
    update(node, spec);
    const atIndex = parent.children[index];
    if (atIndex !== node) parent.insertBefore(node, atIndex || null);
    index += 1;
  }

  for (const stale of existing.values()) stale.remove();
}

/* -------------------------------------------------------------------------
 * Root structure. Created once, then only updated.
 * ---------------------------------------------------------------------- */

function ensureStructure(root) {
  let parts = root.__quickportalParts;
  if (parts && parts.tree.isConnected) return parts;

  const notices = ensureRegion(root, "notices", () => {
    const node = make("div", "notices");
    node.setAttribute("aria-live", "polite");
    return node;
  });

  const head = ensureRegion(root, "head", () => {
    const node = make("header", "portal-head");
    node.append(make("h1", "portal-title"), make("p", "portal-subtitle"));
    return node;
  });

  const sets = ensureRegion(root, "sets", () => {
    const node = make("section", "sets");
    const label = make("h2", "sets-label", "Sets");
    label.id = "qp-sets-label";
    const list = make("ul", "sets-list");
    list.setAttribute("aria-labelledby", label.id);
    node.append(label, list);
    return node;
  });

  const summary = ensureRegion(root, "summary", () => {
    const node = make("p", "filter-summary");
    node.setAttribute("role", "status");
    return node;
  });

  const tree = ensureRegion(root, "tree", () => make("div", "tree"));

  parts = { notices, head, sets, summary, tree };
  root.__quickportalParts = parts;
  attachListeners(root);
  return parts;
}

function ensureRegion(root, name, build) {
  let node = root.querySelector(`:scope > [data-region="${name}"]`);
  if (!node) {
    node = build();
    node.dataset.region = name;
    root.append(node);
  }
  return node;
}

/* -------------------------------------------------------------------------
 * Delegated events. One set of listeners per root, bound on first render.
 * ---------------------------------------------------------------------- */

function bindRoot(root, handlers) {
  boundRoots.set(root, handlers || {});
  attachListeners(root);
}

/** Attached as soon as the structure exists, not on first renderPortal: the
 *  error screen has a Retry button and may be the only thing ever rendered. */
function attachListeners(root) {
  if (root.__quickportalBound) return;
  root.__quickportalBound = true;

  root.addEventListener("click", (event) => {
    const current = boundRoots.get(root) || {};

    const toggle = event.target.closest(".group-toggle");
    if (toggle && root.contains(toggle)) {
      toggleGroup(toggle, current);
      return;
    }

    const setBtn = event.target.closest(".set-btn");
    if (setBtn && root.contains(setBtn)) {
      if (typeof current.onOpenSet === "function") {
        current.onOpenSet(setBtn.dataset.setId);
      }
      return;
    }

    const action = event.target.closest("[data-action]");
    if (action && root.contains(action)) {
      runAction(root, action);
      return;
    }

    // Cards are real links: let the browser navigate and honour `target`.
    const card = event.target.closest("a.card");
    if (card && root.contains(card)) {
      const item = itemForElement.get(card);
      // An embedded item opens inside the portal on a plain activation, and
      // in a browser tab on the clicks the browser already means that way
      // (ctrl/cmd, shift, middle) as well as through its own secondary
      // action. Keeping the card an <a> is what makes those work for free.
      if (
        card.dataset.embed === "true" &&
        isPlainActivation(event) &&
        typeof current.onOpenEmbedded === "function"
      ) {
        event.preventDefault();
        current.onOpenEmbedded(item);
        return;
      }
      if (typeof current.onOpenItem === "function") current.onOpenItem(item);
    }
  });
}

/** A left click with no modifier: everything else is the user asking the
 *  browser for a tab or a window, and we stay out of the way. */
function isPlainActivation(event) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  return event.button === 0 || event.button === undefined;
}

function runAction(root, element) {
  const action = element.dataset.action;
  if (action === "dismiss-notice") {
    const notice = element.closest(".notice");
    if (notice) notice.remove();
    // Focus must not be left on a removed node.
    if (root.isConnected) root.focus({ preventScroll: true });
  } else if (action === "clear-search") {
    root.dispatchEvent(new CustomEvent("quickportal:clear-search", { bubbles: true }));
  } else if (action === "retry") {
    root.dispatchEvent(new CustomEvent("quickportal:retry", { bubbles: true }));
  }
}

function toggleGroup(toggle, handlers) {
  const group = toggle.closest(".group");
  const collapsed = toggle.getAttribute("aria-expanded") === "true";
  setExpanded(group, !collapsed);
  const id = group.dataset.groupId;
  sessionCollapse.set(id, collapsed);
  // While filtering, the pre-filter snapshot is what gets restored on clear.
  if (preFilterCollapse.size) preFilterCollapse.set(id, collapsed);
  if (typeof handlers.onToggleGroup === "function") {
    handlers.onToggleGroup(id, collapsed);
  }
}

/**
 * Expand or collapse every rendered group at once (the palette's expand-all
 * and collapse-all). Returns the group ids so app.js can persist them; the
 * session map is updated here because it takes precedence over storage.
 */
export function setCollapsedAll(root, collapsed) {
  const ids = [];
  for (const group of root.querySelectorAll(".group")) {
    const id = group.dataset.groupId;
    if (!id) continue;
    ids.push(id);
    sessionCollapse.set(id, collapsed);
    if (preFilterCollapse.size) preFilterCollapse.set(id, collapsed);
    setExpanded(group, !collapsed);
  }
  return ids;
}

function setExpanded(group, expanded) {
  const toggle = group.querySelector(":scope > .group-head > .group-toggle");
  const body = group.querySelector(":scope > .group-body");
  setAttr(toggle, "aria-expanded", expanded ? "true" : "false");
  setHidden(body, !expanded);
}

/* -------------------------------------------------------------------------
 * renderPortal
 * ---------------------------------------------------------------------- */

export function renderPortal(root, config, handlers) {
  if (!root || !config) return;
  const parts = ensureStructure(root);
  bindRoot(root, handlers);
  applyLayout(root, config);

  renderHead(parts, config);
  renderSets(parts.sets, config);

  const groups = Array.isArray(config.groups) ? config.groups : [];
  renderGroups(parts.tree, groups, 0);
  if (!groups.length) parts.tree.append(buildEmptyState());

  setHidden(parts.head, false);
  setHidden(parts.tree, false);
}

/** Layout knobs from the config, applied as scoped custom properties.
 *  This is CSSOM, not an inline style attribute, so the CSP is satisfied. */
function applyLayout(root, config) {
  const layout = config.layout || {};
  const width = String(layout.minCardWidth || "").trim();
  root.style.setProperty(
    "--min-card-width",
    CSS_LENGTH.test(width) ? width : "14rem",
  );
  root.dataset.density = layout.density === "compact" ? "compact" : "comfortable";
}

function renderHead(parts, config) {
  const title = config.title || "QuickPortal";
  setText(parts.head.querySelector(".portal-title"), title);
  const subtitleNode = parts.head.querySelector(".portal-subtitle");
  setText(subtitleNode, config.subtitle || "");
  setHidden(subtitleNode, !config.subtitle);
}

function renderSets(section, config) {
  const sets = Array.isArray(config.sets) ? config.sets : [];
  setHidden(section, sets.length === 0);
  const list = section.querySelector(".sets-list");
  reconcile(
    list,
    sets.map((set) => ({ key: `s:${set.id}`, set })),
    () => {
      const li = make("li");
      const button = make("button", "btn set-btn");
      button.type = "button";
      button.append(make("span", "icon-slot"), make("span", "set-name"));
      li.append(button);
      return li;
    },
    (li, spec) => {
      const { set } = spec;
      const button = li.querySelector(".set-btn");
      button.dataset.setId = set.id;
      button.dataset.focusKey = `set:${set.id}`;
      setText(button.querySelector(".set-name"), set.name || set.id);
      setAttr(
        button,
        "aria-label",
        `Open set: ${set.name || set.id}`,
      );
      syncIcon(button.querySelector(".icon-slot"), set.icon, set.name || set.id, null);
    },
  );
}

/* -------------------------------------------------------------------------
 * Groups and items
 * ---------------------------------------------------------------------- */

function renderGroups(container, groups, depth) {
  reconcile(
    container,
    groups.map((group) => ({ key: `g:${group.id}`, group })),
    () => buildGroup(depth),
    (node, spec) => updateGroup(node, spec.group, depth),
  );
}

function buildGroup(depth) {
  const section = make("section", "group");
  section.dataset.depth = String(depth);

  // h2 at the top level, one level deeper per nesting level, floored at h6.
  const heading = make("h" + Math.min(depth + 2, 6), "group-head");
  const toggle = make("button", "group-toggle");
  toggle.type = "button";
  toggle.append(
    make("span", "chev", "▼"),
    make("span", "icon-slot"),
    make("span", "group-name"),
    make("span", "group-count"),
  );
  heading.append(toggle);

  const body = make("div", "group-body");
  body.setAttribute("role", "region");
  body.append(make("ul", "items"), make("div", "subgroups"));

  section.append(heading, body);
  return section;
}

function updateGroup(section, group, depth) {
  const id = group.id;
  section.dataset.groupId = id;

  const toggle = section.querySelector(":scope > .group-head > .group-toggle");
  const body = section.querySelector(":scope > .group-body");

  const bodyId = `qp-g-${domSafe(id)}-body`;
  const labelId = `qp-g-${domSafe(id)}-label`;
  toggle.id = labelId;
  toggle.dataset.focusKey = `group:${id}`;
  setAttr(toggle, "aria-controls", bodyId);
  body.id = bodyId;
  setAttr(body, "aria-labelledby", labelId);

  setText(toggle.querySelector(".group-name"), group.name || id);
  syncIcon(toggle.querySelector(".icon-slot"), group.icon, group.name || id, null);

  const count = countItems(group);
  const countNode = toggle.querySelector(".group-count");
  setText(countNode, count ? String(count) : "");
  // Decorative: the button's accessible name stays the group name.
  setAttr(countNode, "aria-hidden", "true");
  setChevronHidden(toggle);

  setExpanded(section, !resolveCollapsed(id, !!group.collapsed));

  renderItems(body.querySelector(":scope > .items"), group.items || []);
  renderGroups(
    body.querySelector(":scope > .subgroups"),
    Array.isArray(group.groups) ? group.groups : [],
    depth + 1,
  );
}

function setChevronHidden(toggle) {
  setAttr(toggle.querySelector(".chev"), "aria-hidden", "true");
}

function resolveCollapsed(id, fallback) {
  if (sessionCollapse.has(id)) return sessionCollapse.get(id);
  try {
    return Boolean(isCollapsed(id, fallback));
  } catch {
    return fallback;
  }
}

function countItems(group) {
  let total = Array.isArray(group.items) ? group.items.length : 0;
  for (const child of Array.isArray(group.groups) ? group.groups : []) {
    total += countItems(child);
  }
  return total;
}

function renderItems(list, items) {
  reconcile(
    list,
    items.map((item) => ({ key: `i:${item.id}`, item })),
    () => {
      const li = make("li", "item");
      const card = make("a", "card");
      const body = make("span", "card-body");
      body.append(make("span", "card-name"));
      card.append(make("span", "icon-slot"), body);
      li.append(card);
      return li;
    },
    (li, spec) => updateItem(li, spec.item),
  );
}

function updateItem(li, item) {
  const card = li.querySelector(".card");
  const body = card.querySelector(".card-body");
  const name = item.name || item.id || item.url;
  const base = `qp-i-${domSafe(item.id)}`;

  itemForElement.set(card, item);
  setAttr(card, "href", item.url || "#");
  const target = item.target === "_self" ? "_self" : "_blank";
  setAttr(card, "target", target);
  setAttr(card, "rel", target === "_blank" ? "noopener noreferrer" : null);
  card.dataset.focusKey = `item:${item.id}`;

  const nameNode = body.querySelector(".card-name");
  nameNode.id = `${base}-name`;
  setText(nameNode, name);

  const describedBy = [];

  // Description: present only when configured, so empty nodes do not take
  // vertical space or get announced.
  let descNode = body.querySelector(".card-desc");
  if (item.description) {
    if (!descNode) {
      descNode = make("span", "card-desc");
      body.append(descNode);
    }
    descNode.id = `${base}-desc`;
    setText(descNode, item.description);
    describedBy.push(descNode.id);
  } else if (descNode) {
    descNode.remove();
  }

  const tags = Array.isArray(item.tags) ? item.tags.filter(Boolean) : [];
  let tagsNode = body.querySelector(".card-tags");
  if (tags.length) {
    if (!tagsNode) {
      tagsNode = make("span", "card-tags");
      body.append(tagsNode);
    }
    tagsNode.id = `${base}-tags`;
    reconcile(
      tagsNode,
      tags.map((tag) => ({ key: `t:${tag}`, tag })),
      () => make("span", "tag"),
      (node, spec) => setText(node, spec.tag),
    );
    describedBy.push(tagsNode.id);
  } else if (tagsNode) {
    tagsNode.remove();
  }

  // The accessible name is the item's name; description and tags are the
  // accessible description. The URL is never read out as the name.
  setAttr(card, "aria-labelledby", nameNode.id);
  setAttr(card, "aria-describedby", describedBy.length ? describedBy.join(" ") : null);

  syncIcon(card.querySelector(".icon-slot"), item.icon, name, item.url);
  updateEmbedAffordances(li, card, body, item, name, base, describedBy);
  li.dataset.search = searchHaystack(item);
}

/**
 * The two things an embedded item gets that an ordinary one does not: a badge
 * saying the card opens inside the portal, and a separate link that opens it
 * in a browser tab. The link is a sibling of the card rather than a child,
 * because an <a> inside an <a> is not valid and would not be focusable.
 *
 * `embed` can be turned off in a live config change, so both are removed again
 * when it is: an item that stops being embedded has to behave exactly as it
 * did before the feature existed.
 */
function updateEmbedAffordances(li, card, body, item, name, base, describedBy) {
  const embedded = item.embed === true;
  li.dataset.embed = embedded ? "true" : "false";
  if (embedded) card.dataset.embed = "true";
  else delete card.dataset.embed;

  let badge = body.querySelector(".card-embed");
  if (embedded) {
    if (!badge) {
      badge = make("span", "card-embed", "Opens in the portal");
      body.append(badge);
    }
    badge.id = `${base}-embed`;
    describedBy.push(badge.id);
    setAttr(card, "aria-describedby", describedBy.join(" "));
  } else if (badge) {
    badge.remove();
  }

  let extern = li.querySelector(":scope > .card-extern");
  if (embedded) {
    if (!extern) {
      extern = make("a", "card-extern");
      const glyph = make("span", "card-extern-glyph", "\u2197");
      glyph.setAttribute("aria-hidden", "true");
      extern.append(glyph, make("span", "vh"));
      li.append(extern);
    }
    setAttr(extern, "href", item.url || "#");
    setAttr(extern, "target", "_blank");
    setAttr(extern, "rel", "noopener noreferrer");
    // The glyph carries no text, so the accessible name is the hidden span.
    setText(extern.querySelector(".vh"), `Open ${name} in a browser tab`);
    extern.dataset.focusKey = `item-extern:${item.id}`;
  } else if (extern) {
    extern.remove();
  }
}

function searchHaystack(item) {
  const tags = Array.isArray(item.tags) ? item.tags.join(" ") : "";
  return [item.name, item.description, tags, item.url]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/* -------------------------------------------------------------------------
 * Icons. Text, a URL, or `auto` (the origin's favicon). Any load failure
 * falls back to initials, so there is never a broken-image glyph.
 * ---------------------------------------------------------------------- */

function syncIcon(slot, icon, name, url) {
  const spec = String(icon == null ? "" : icon).trim();
  const signature = `${spec}|${url || ""}|${name || ""}`;
  if (slot.dataset.iconSig === signature) return;
  slot.dataset.iconSig = signature;
  slot.textContent = "";

  if (!spec) {
    // Groups get no placeholder; items fall back to initials for an even grid.
    if (url) slot.append(initialsIcon(name));
    return;
  }

  const src = spec === "auto" ? faviconFor(url) : URL_ICON.test(spec) ? spec : null;
  if (!src) {
    slot.append(textIcon(spec));
    return;
  }

  const img = make("img", "icon icon-img");
  img.src = src;
  img.alt = "";
  img.width = 32;
  img.height = 32;
  img.loading = "lazy";
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  img.setAttribute("aria-hidden", "true");
  img.addEventListener(
    "error",
    () => {
      img.replaceWith(initialsIcon(name));
    },
    { once: true },
  );
  slot.append(img);
}

function faviconFor(url) {
  try {
    return new URL(url, document.baseURI).origin + "/favicon.ico";
  } catch {
    return null;
  }
}

function textIcon(text) {
  const node = make("span", "icon icon-text", text);
  node.setAttribute("aria-hidden", "true");
  return node;
}

function initialsIcon(name) {
  const node = make("span", "icon icon-initials", initials(name));
  node.setAttribute("aria-hidden", "true");
  return node;
}

export function initials(name) {
  const words = String(name || "?")
    .split(/[\s_\-./]+/)
    .filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/* -------------------------------------------------------------------------
 * Empty state
 * ---------------------------------------------------------------------- */

function buildEmptyState() {
  const panel = make("div", "panel");
  panel.append(
    make("h2", null, "No bookmarks yet"),
    make(
      "p",
      null,
      "The config loaded without errors but declares no groups. Add a group " +
        "with at least one item to ./config/config.yaml and the page will " +
        "pick it up on the next poll.",
    ),
  );
  const example = make(
    "pre",
    null,
    [
      "version: 1",
      "title: Home",
      "groups:",
      "  - name: Media",
      "    items:",
      "      - name: Library",
      "        url: https://library.example.com",
    ].join("\n"),
  );
  panel.append(example);
  return panel;
}

/* -------------------------------------------------------------------------
 * Notices, errors and warnings
 * ---------------------------------------------------------------------- */

const CONFIG_HINTS = [
  "Check that the config ConfigMap is mounted at ./config/config.yaml inside the served tree.",
  "A ConfigMap mounted with subPath is never updated by kubelet, and an immutable ConfigMap never changes at all.",
  "Validate the file before applying it: tools/validate-config.mjs uses the same module as this page.",
];

/**
 * Render a notice into the portal's notice area.
 * `id` replaces any notice previously rendered with the same id, so repeated
 * events (set results, reload failures) do not stack up.
 */
export function renderNotice(root, notice) {
  const parts = ensureStructure(root);
  const { kind = "info", title, message, hints, links, issues, dismissible, id, actions } =
    notice || {};

  const node = make("div", `notice notice-${kind}`);
  if (id) {
    node.dataset.noticeId = id;
    const previous = parts.notices.querySelector(`[data-notice-id="${CSS.escape(id)}"]`);
    if (previous) previous.remove();
  }

  const head = make("div", "notice-head");
  head.append(make("h2", "notice-title", title || ""));
  if (dismissible) {
    const close = make("button", "btn btn-quiet");
    close.type = "button";
    close.dataset.action = "dismiss-notice";
    close.append(make("span", null, "×"), make("span", "vh", "Dismiss this notice"));
    head.append(close);
  }
  node.append(head);

  if (message) node.append(make("p", "notice-body", message));
  if (Array.isArray(issues) && issues.length) node.append(buildIssueList(issues));
  if (Array.isArray(hints) && hints.length) {
    const ul = make("ul", "notice-hints");
    for (const hint of hints) ul.append(make("li", null, hint));
    node.append(ul);
  }
  if (Array.isArray(links) && links.length) {
    const list = make("div", "notice-links");
    for (const link of links) {
      const anchor = make("a", null, link.name || link.url);
      anchor.href = link.url;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      list.append(anchor);
    }
    node.append(list);
  }
  if (Array.isArray(actions) && actions.length) {
    const row = make("div", "notice-actions");
    for (const action of actions) {
      const button = make("button", "btn" + (action.primary ? " btn-accent" : ""));
      button.type = "button";
      button.dataset.action = action.action;
      button.textContent = action.label;
      row.append(button);
    }
    node.append(row);
  }

  parts.notices.append(node);
  return node;
}

function buildIssueList(issues) {
  const list = make("div", "issue-list");
  for (const issue of issues) {
    const row = make("div", "issue");
    row.append(
      make("span", "issue-path", issue.path ? `${issue.path}:` : "config:"),
      make("span", "issue-message", issue.message || String(issue)),
    );
    list.append(row);
  }
  return list;
}

/**
 * Errors and warnings from parsing or normalising the config.
 *
 * Errors with no tree on screen replace the tree, because a half-rendered
 * portal from a broken config is worse than none. Errors arriving while a good
 * tree is already rendered (a live reload of a config that just broke) are
 * shown above the intact tree instead, which is what live-config-reload asks
 * for. Warnings never remove anything and are dismissible.
 */
export function renderIssues(root, errors, warnings) {
  const parts = ensureStructure(root);
  const errorList = Array.isArray(errors) ? errors : [];
  const warningList = Array.isArray(warnings) ? warnings : [];

  parts.notices.textContent = "";

  const hasTree = parts.tree.querySelector(".group") !== null;

  if (errorList.length) {
    renderNotice(root, {
      kind: "error",
      id: "config-errors",
      title: errorTitle(errorList, hasTree),
      message: hasTree
        ? "The page below is still showing the last config that loaded cleanly."
        : "Nothing is rendered from a config with errors. Fix the problems below and the page will pick up the change on the next poll.",
      issues: errorList,
      hints: hasTree ? null : CONFIG_HINTS,
      actions: [{ action: "retry", label: "Retry now", primary: true }],
    });

    if (!hasTree) {
      setHidden(parts.head, true);
      setHidden(parts.sets, true);
      setHidden(parts.tree, true);
    }
  }

  if (warningList.length) {
    renderNotice(root, {
      kind: "warn",
      id: "config-warnings",
      title:
        warningList.length === 1
          ? "1 warning in the config"
          : `${warningList.length} warnings in the config`,
      message: "The portal rendered everything it understood and ignored the rest.",
      issues: warningList,
      dismissible: true,
    });
  }
}

function errorTitle(errors, hasTree) {
  const count = errors.length === 1 ? "1 problem" : `${errors.length} problems`;
  return hasTree ? `${count} in the new config` : `${count} in the config`;
}

/* -------------------------------------------------------------------------
 * applyFilter
 * ---------------------------------------------------------------------- */

/**
 * Filter the rendered tree by a query over name, description, tags and URL.
 * Groups holding a match are expanded for the duration of the filter without
 * writing to the stored collapse state, so clearing the query puts the tree
 * back exactly as the user left it. Returns the number of visible items.
 */
export function applyFilter(root, query) {
  const parts = ensureStructure(root);
  const terms = String(query || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  if (!terms.length) return clearFilter(parts, root);

  if (!root.dataset.filtering) {
    snapshotCollapse(parts.tree);
    root.dataset.filtering = "true";
  }

  let matches = 0;
  for (const li of parts.tree.querySelectorAll(".item")) {
    const haystack = li.dataset.search || "";
    const visible = terms.every((term) => haystack.includes(term));
    setHidden(li, !visible);
    if (visible) matches += 1;
  }

  // Bottom-up so a parent sees whether any descendant survived.
  const groups = Array.from(parts.tree.querySelectorAll(".group")).reverse();
  for (const group of groups) {
    const hasMatch =
      group.querySelector(":scope > .group-body > .items > .item:not([hidden])") !== null ||
      group.querySelector(":scope > .group-body > .subgroups > .group:not([hidden])") !== null;
    setHidden(group, !hasMatch);
    if (hasMatch) setExpanded(group, true);
  }

  renderFilterSummary(parts, matches, query);
  return matches;
}

function clearFilter(parts, root) {
  delete root.dataset.filtering;
  for (const li of parts.tree.querySelectorAll(".item[hidden]")) setHidden(li, false);
  for (const group of parts.tree.querySelectorAll(".group[hidden]")) setHidden(group, false);

  // Only groups whose state was changed for the sake of the filter are
  // restored; anything the filter never touched keeps what renderPortal set,
  // which is where the config's own `collapsed` lives.
  for (const group of parts.tree.querySelectorAll(".group")) {
    const id = group.dataset.groupId;
    if (!preFilterCollapse.has(id)) continue;
    setExpanded(group, !preFilterCollapse.get(id));
  }
  preFilterCollapse.clear();

  setText(parts.summary, "");
  removeNoMatchPanel(parts);
  return parts.tree.querySelectorAll(".item").length;
}

function snapshotCollapse(tree) {
  preFilterCollapse.clear();
  for (const group of tree.querySelectorAll(".group")) {
    const toggle = group.querySelector(":scope > .group-head > .group-toggle");
    preFilterCollapse.set(group.dataset.groupId, toggle.getAttribute("aria-expanded") === "false");
  }
}

function renderFilterSummary(parts, matches, query) {
  const trimmed = String(query || "").trim();
  if (matches > 0) {
    setText(
      parts.summary,
      `${matches} ${matches === 1 ? "bookmark" : "bookmarks"} match “${trimmed}”.`,
    );
    removeNoMatchPanel(parts);
    return;
  }

  setText(parts.summary, "");
  let panel = parts.tree.querySelector(":scope > .panel[data-nomatch]");
  if (!panel) {
    panel = make("div", "panel");
    panel.dataset.nomatch = "true";
    panel.dataset.key = "nomatch";
    panel.append(make("h2", null, "No matches"), make("p", "nomatch-text"));
    const button = make("button", "btn btn-accent", "Clear search");
    button.type = "button";
    button.dataset.action = "clear-search";
    panel.append(button);
    parts.tree.append(panel);
  }
  setText(
    panel.querySelector(".nomatch-text"),
    `Nothing matches “${trimmed}” in any name, description, tag or URL.`,
  );
}

function removeNoMatchPanel(parts) {
  const panel = parts.tree.querySelector(":scope > .panel[data-nomatch]");
  if (panel) panel.remove();
}

/* -------------------------------------------------------------------------
 * The tab strip, its controls and the nudge bar
 *
 * Everything here is drawn from the frame host's change list and nothing else.
 * No frame element is created, moved, removed or navigated from this module:
 * see the contract at the top of frames.js.
 *
 * Why #tab-strip holds nothing but tabs: a `tablist` may only own `tab`
 * children, so the close button lives inside its own tab (which is why a tab
 * is a div with role="tab", as the ARIA practices do for deletable tabs,
 * rather than a <button> that cannot legally contain one), and the group
 * controls and the nudge bar are separate siblings created once. They are
 * siblings of #frame-host rather than children of it, because its children
 * belong to the frame host.
 *
 * The tab's accessible name is pinned to its name span with aria-labelledby,
 * so neither the close button's label nor the icon can leak into it.
 * ---------------------------------------------------------------------- */

const STRIP_CONTROLS_ID = "qp-tabstrip-controls";
const NUDGE_ID = "qp-frame-nudge";

/** Handlers for the strip and its controls, per strip element. */
const stripHandlers = new WeakMap();
const nudgeHandlers = new WeakMap();
const boundStrips = new WeakSet();

/**
 * Where focus goes after the strip next renders: a tab id, or "portal" when
 * the strip is about to vanish from under the keyboard. Closing a tab must not
 * drop focus on the document.
 */
let pendingTabFocus = null;

/**
 * Render the strip of mounted apps.
 *
 * @param {Element} strip  #tab-strip, the tablist
 * @param {object} model   {tabs, max, focusMode} - `tabs` is host.list()
 * @param {object} handlers
 *   onFocusTab(id), onCloseTab(id), onRefreshFocused(), onRefreshAll(),
 *   onCloseAll(), onToggleFocusMode()
 */
export function renderTabStrip(strip, model, handlers) {
  if (!strip) return;
  stripHandlers.set(strip, handlers || {});
  attachStripListeners(strip);

  const tabs = Array.isArray(model && model.tabs) ? model.tabs : [];
  const max = Number(model && model.max) > 0 ? Number(model.max) : tabs.length;
  const focusMode = Boolean(model && model.focusMode);
  const controls = ensureStripControls(strip);
  const empty = tabs.length === 0;

  reconcile(
    strip,
    tabs.map((tab, index) => ({
      key: `f:${tab.id}`,
      tab,
      index: index + 1,
      total: tabs.length,
    })),
    buildTab,
    (node, spec) => updateTab(node, spec.tab, spec.index, spec.total),
  );

  // Roving tabindex: exactly one tab is reachable with Tab, and the arrow keys
  // move between them from there. If the host reports no focused frame, the
  // first tab takes the stop so the strip never becomes unreachable.
  if (!empty && !tabs.some((tab) => tab.focused)) {
    const first = strip.querySelector(":scope > .tab");
    if (first) first.tabIndex = 0;
  }

  updateStripControls(controls, tabs, max, focusMode);

  // Hidden entirely when nothing is mounted: an empty strip is chrome that
  // explains nothing.
  setHidden(strip, empty);
  setHidden(controls, empty);

  applyPendingTabFocus(strip);
}

function buildTab() {
  const tab = make("div", "tab");
  tab.setAttribute("role", "tab");
  tab.append(make("span", "icon-slot"), make("span", "tab-name"));

  const close = make("button", "tab-close");
  close.type = "button";
  // Not a tab stop of its own: a tablist with two stops per tab is miserable
  // to walk. The keyboard path is Delete or Backspace on the tab itself, which
  // is announced through aria-keyshortcuts.
  close.tabIndex = -1;
  close.dataset.stripAction = "close-tab";
  const glyph = make("span", "tab-close-glyph", "×");
  glyph.setAttribute("aria-hidden", "true");
  close.append(glyph);
  tab.append(close);
  return tab;
}

function updateTab(tab, entry, index, total) {
  const item = entry.item || {};
  const name = item.name || item.id || entry.id;
  const base = `qp-tab-${domSafe(entry.id)}`;

  tab.dataset.tabId = entry.id;
  tab.dataset.focusKey = `tab:${entry.id}`;
  tab.id = base;

  const nameNode = tab.querySelector(".tab-name");
  nameNode.id = `${base}-name`;
  setText(nameNode, name);

  setAttr(tab, "aria-labelledby", nameNode.id);
  setAttr(tab, "aria-selected", entry.focused ? "true" : "false");
  // Position and size are how the strip conveys "the third of four" without
  // padding the accessible name with a count.
  setAttr(tab, "aria-posinset", String(index));
  setAttr(tab, "aria-setsize", String(total));
  setAttr(tab, "aria-keyshortcuts", "Delete");
  tab.tabIndex = entry.focused ? 0 : -1;

  const close = tab.querySelector(".tab-close");
  setAttr(close, "aria-label", `Close ${name}`);
  setAttr(close, "title", `Close ${name}`);

  syncIcon(tab.querySelector(".icon-slot"), item.icon, name, item.url);
}

/**
 * The group controls, as a sibling of the strip rather than inside it, so the
 * tablist keeps owning tabs and only tabs.
 */
function ensureStripControls(strip) {
  let controls = strip.__quickportalControls;
  if (controls && controls.isConnected) return controls;

  controls = strip.ownerDocument.getElementById(STRIP_CONTROLS_ID);
  if (!controls) {
    controls = make("div", "shell tabstrip-controls");
    controls.id = STRIP_CONTROLS_ID;
    const count = make("p", "tabstrip-count");
    // A live region: the mounted count changes without the user asking.
    count.setAttribute("role", "status");
    controls.append(
      count,
      controlButton("refresh-focused", "↻", "Refresh"),
      controlButton("refresh-all", "⟳", "Refresh all"),
      controlButton("close-all", "×", "Close all"),
      controlButton("focus-mode", "⛶", "Focus mode"),
    );
    controls.hidden = true;
    strip.after(controls);

    controls.addEventListener("click", (event) => {
      const button = event.target.closest("[data-strip-action]");
      if (!button) return;
      const current = stripHandlers.get(strip) || {};
      const action = button.dataset.stripAction;
      if (action === "refresh-focused") call(current.onRefreshFocused);
      else if (action === "refresh-all") call(current.onRefreshAll);
      else if (action === "close-all") call(current.onCloseAll);
      else if (action === "focus-mode") call(current.onToggleFocusMode);
    });
  }

  strip.__quickportalControls = controls;
  return controls;
}

function controlButton(action, glyph, label) {
  const button = make("button", "btn btn-quiet");
  button.type = "button";
  button.dataset.stripAction = action;
  const icon = make("span", null, glyph);
  icon.setAttribute("aria-hidden", "true");
  // The label is the first thing the narrow toolbar drops, so every one of
  // these also carries an aria-label; updateStripControls keeps them in step.
  button.append(icon, make("span", "btn-label", label));
  return button;
}

function updateStripControls(controls, tabs, max, focusMode) {
  const count = tabs.length;
  // The count can legitimately sit above the cap: lowering the cap closes
  // nothing, so it drains one open at a time. Say so rather than pretend.
  const over = count > max ? ", over the limit" : "";
  setText(
    controls.querySelector(".tabstrip-count"),
    count ? `${count} of ${max} open${over}` : "",
  );

  const focused = tabs.find((tab) => tab.focused) || null;
  const focusedName = focused ? focused.item.name || focused.id : null;

  labelControl(controls, "refresh-focused", "Refresh", focusedName ? `Reload ${focusedName}` : "Reload this app");
  labelControl(controls, "refresh-all", "Refresh all", `Reload all ${count} open apps`);
  labelControl(controls, "close-all", "Close all", `Close all ${count} open apps`);
  labelControl(
    controls,
    "focus-mode",
    focusMode ? "Leave focus mode" : "Focus mode",
    focusMode ? "Leave focus mode" : "Focus mode: give the viewport to the open app",
  );

  const focusButton = controls.querySelector('[data-strip-action="focus-mode"]');
  setAttr(focusButton, "aria-pressed", focusMode ? "true" : "false");
}

function labelControl(controls, action, label, ariaLabel) {
  const button = controls.querySelector(`[data-strip-action="${action}"]`);
  if (!button) return;
  setText(button.querySelector(".btn-label"), label);
  setAttr(button, "aria-label", ariaLabel);
}

function attachStripListeners(strip) {
  if (boundStrips.has(strip)) return;
  boundStrips.add(strip);

  strip.addEventListener("click", (event) => {
    const current = stripHandlers.get(strip) || {};
    const close = event.target.closest(".tab-close");
    if (close) {
      const owner = close.closest(".tab");
      if (owner) requestCloseTab(strip, owner.dataset.tabId, current);
      return;
    }
    const tab = event.target.closest(".tab");
    if (tab && typeof current.onFocusTab === "function") current.onFocusTab(tab.dataset.tabId);
  });

  strip.addEventListener("keydown", (event) => {
    if (event.defaultPrevented) return;
    const current = stripHandlers.get(strip) || {};
    const tab = event.target.closest(".tab");
    if (!tab) return;

    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        moveTabFocus(strip, tab, 1, current);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        moveTabFocus(strip, tab, -1, current);
        break;
      case "Home":
        event.preventDefault();
        activateTabAt(strip, 0, current);
        break;
      case "End":
        event.preventDefault();
        activateTabAt(strip, -1, current);
        break;
      case "Delete":
      case "Backspace":
        event.preventDefault();
        requestCloseTab(strip, tab.dataset.tabId, current);
        break;
      case "Enter":
      case " ":
        // role="tab" on a div means Enter and Space are ours to honour.
        event.preventDefault();
        if (typeof current.onFocusTab === "function") current.onFocusTab(tab.dataset.tabId);
        break;
      default:
        break;
    }
  });
}

function stripTabs(strip) {
  return Array.from(strip.querySelectorAll(":scope > .tab"));
}

function moveTabFocus(strip, from, delta, handlers) {
  const tabs = stripTabs(strip);
  if (tabs.length < 2) return;
  const index = tabs.indexOf(from);
  activateTab(tabs[(index + delta + tabs.length) % tabs.length], handlers);
}

function activateTabAt(strip, position, handlers) {
  const tabs = stripTabs(strip);
  if (!tabs.length) return;
  activateTab(position === -1 ? tabs[tabs.length - 1] : tabs[position], handlers);
}

/**
 * Automatic activation: arrowing onto a tab shows its frame. Showing a frame is
 * a visibility change in the host, never a navigation, so nothing reloads.
 */
function activateTab(tab, handlers) {
  if (!tab) return;
  const id = tab.dataset.tabId;
  if (typeof handlers.onFocusTab === "function") handlers.onFocusTab(id);
  // The re-render reuses the same node for the same id, but check anyway
  // rather than focus a node that was replaced underneath us.
  const again = tab.isConnected
    ? tab
    : tab.ownerDocument.querySelector(`.tab[data-tab-id="${CSS.escape(id)}"]`);
  if (again) again.focus({ preventScroll: true });
}

/**
 * Close a tab and decide where focus lands before the strip changes under us:
 * the tab to the right, else the one to the left, else the portal. The host
 * calls back synchronously, so applyPendingTabFocus runs inside this call.
 */
function requestCloseTab(strip, id, handlers) {
  if (!id || typeof handlers.onCloseTab !== "function") return;
  const ids = stripTabs(strip).map((tab) => tab.dataset.tabId);
  const index = ids.indexOf(id);
  const neighbour = ids[index + 1] || ids[index - 1] || null;
  const hadFocus = strip.contains(strip.ownerDocument.activeElement);
  pendingTabFocus = hadFocus ? neighbour || "portal" : null;
  handlers.onCloseTab(id);
  // If the host closed nothing, the request is simply dropped.
  pendingTabFocus = null;
}

function applyPendingTabFocus(strip) {
  const wanted = pendingTabFocus;
  pendingTabFocus = null;
  if (!wanted) return;
  if (wanted === "portal") {
    const portal = strip.ownerDocument.getElementById("portal");
    if (portal) portal.focus({ preventScroll: true });
    return;
  }
  const tab = strip.querySelector(`:scope > .tab[data-tab-id="${CSS.escape(wanted)}"]`);
  if (tab) tab.focus({ preventScroll: true });
}

function call(fn) {
  if (typeof fn === "function") fn();
}

/* -------------------------------------------------------------------------
 * The nudge bar
 *
 * The host marks a frame `nudged` a few seconds after mounting it. That is a
 * timer, not a diagnosis: nothing in this app can see whether a cross-origin
 * frame loaded, was refused, is slow or is down, and the browser's own refusal
 * page fires `load` just like a working app. So the bar appears over apps that
 * are working perfectly well, and therefore:
 *
 *  - it covers and dims nothing, it sits in the flow at the bottom edge of the
 *    frame area and the frame area shrinks by its height,
 *  - every cause is conditional ("if this app has not loaded"), never a
 *    statement that the target refused framing,
 *  - it is dismissible per app.
 * ---------------------------------------------------------------------- */

const NUDGE_HINTS = [
  "The app may not permit framing: X-Frame-Options, or a Content-Security-Policy whose frame-ancestors does not list this portal's origin.",
  "It may be logging you out invisibly, because a session cookie without SameSite=None; Secure is not sent to a frame on another site.",
  "It may simply be slow, erroring or unreachable, which looks exactly the same from here.",
];

/**
 * Render the escape hatch for the focused frame, or hide it.
 *
 * @param {Element} frameHost  #frame-host; the bar is inserted after it
 * @param {object} model   {tab, docsUrl} - `tab` is the entry to nudge, or null
 * @param {object} handlers  onDismiss(id), onOpenExternal(id)
 */
export function renderFrameNudge(frameHost, model, handlers) {
  if (!frameHost) return;
  const bar = ensureNudgeBar(frameHost);
  nudgeHandlers.set(bar, handlers || {});

  const tab = (model && model.tab) || null;
  if (!tab) {
    delete bar.dataset.tabId;
    setHidden(bar, true);
    return;
  }

  const item = tab.item || {};
  const name = item.name || tab.id;
  bar.dataset.tabId = tab.id;

  setText(
    bar.querySelector(".nudge-title"),
    `If ${name} has not loaded, here is the way out`,
  );
  setText(
    bar.querySelector(".nudge-body"),
    "QuickPortal cannot see inside a frame from another origin, so it does not " +
      "know whether this app is showing you something or not. If the area above " +
      "is blank, any of these could be why:",
  );

  const open = bar.querySelector(".nudge-open");
  setAttr(open, "href", item.url || "#");
  setText(open.querySelector(".nudge-open-label"), `Open ${name} in a browser tab`);

  const docs = bar.querySelector(".nudge-docs");
  const docsUrl = model && model.docsUrl;
  setAttr(docs, "href", docsUrl || null);
  setHidden(docs, !docsUrl);

  setHidden(bar, false);
}

/**
 * The header requirements, spelled out in the page.
 *
 * The repository's documentation is not part of the served tree (the served
 * files are a flat ConfigMap), and hardcoding a documentation host into a
 * static page would be a guess about someone else's deployment. So the exact
 * headers are here, collapsed, and the model's optional `docsUrl` adds a link
 * when a deployment has one.
 */
function buildHeaderHelp() {
  const details = make("details", "nudge-headers");
  details.append(make("summary", null, "What the app has to send to be frameable"));
  details.append(
    make(
      "p",
      "nudge-note",
      "On the embedded app, not on QuickPortal. Replace the origin with the one " +
        "this portal is served from.",
    ),
    make(
      "pre",
      null,
      [
        "Content-Security-Policy: frame-ancestors https://portal.example.com",
        "",
        "# and no X-Frame-Options: DENY / SAMEORIGIN header,",
        "# which older browsers honour instead of frame-ancestors.",
      ].join("\n"),
    ),
    make(
      "p",
      "nudge-note",
      "QuickPortal's own policy has to allow it too: frame-src in the server " +
        "config must list the app's origin, and it ships as 'none'.",
    ),
  );
  return details;
}

function ensureNudgeBar(frameHost) {
  let bar = frameHost.__quickportalNudge;
  if (bar && bar.isConnected) return bar;

  bar = frameHost.ownerDocument.getElementById(NUDGE_ID);
  if (!bar) {
    bar = make("div", "shell frame-nudge");
    bar.id = NUDGE_ID;
    bar.setAttribute("role", "region");

    const title = make("h2", "nudge-title");
    title.id = `${NUDGE_ID}-title`;
    bar.setAttribute("aria-labelledby", title.id);

    const hints = make("ul", "nudge-hints");
    for (const hint of NUDGE_HINTS) hints.append(make("li", null, hint));

    const actions = make("div", "nudge-actions");
    const open = make("a", "btn btn-accent nudge-open");
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    open.append(make("span", "nudge-open-label"));
    const docs = make("a", "btn nudge-docs", "Read the documentation");
    docs.target = "_blank";
    docs.rel = "noopener noreferrer";
    const dismiss = make("button", "btn btn-quiet", "Dismiss");
    dismiss.type = "button";
    dismiss.dataset.nudgeAction = "dismiss";
    actions.append(open, docs, dismiss);

    // Two rows by default. The bar appears over apps that loaded perfectly
    // well, so the reasoning is folded away and only the way out is in sight.
    const why = make("details", "nudge-why");
    why.append(make("summary", null, "Why a frame can stay blank"));
    why.append(make("p", "nudge-body"), hints, buildHeaderHelp());
    bar.append(title, actions, why);
    bar.hidden = true;
    frameHost.after(bar);

    bar.addEventListener("click", (event) => {
      const current = nudgeHandlers.get(bar) || {};
      const id = bar.dataset.tabId;
      if (event.target.closest("[data-nudge-action='dismiss']")) {
        if (typeof current.onDismiss === "function") current.onDismiss(id);
        return;
      }
      if (event.target.closest(".nudge-open") && typeof current.onOpenExternal === "function") {
        current.onOpenExternal(id);
      }
    });
  }

  frameHost.__quickportalNudge = bar;
  return bar;
}
