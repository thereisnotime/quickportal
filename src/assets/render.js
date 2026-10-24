/**
 * render.js - everything that touches the DOM inside the portal root.
 *
 * Public surface (the contract in design.md):
 *   renderPortal(root, config, handlers)
 *   renderIssues(root, errors, warnings)
 *   applyFilter(root, query) -> matchCount
 *   renderTabStrip(strip, model, handlers)   the strip of embedded apps
 *   renderFrameNudge(frameHost, model, handlers)   the escape hatch
 *   renderDiagramPanel(host, model, handlers)   the collapsible diagram
 *   DIAGRAM_SCOPE_ID   the id the extracted diagram CSS is scoped to
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
 *  This is CSSOM, not an inline style attribute, so the CSP is satisfied.
 *
 *  Density is deliberately not set here. It is a viewer preference layered
 *  over `layout.density`, so app.js resolves the two and writes the one
 *  surviving value to <html>. Writing it here as well would mean a viewer who
 *  picked comfortable over a compact config still matched the compact
 *  descendant selectors through this element, and their choice would do
 *  nothing. One writer, on the root. */
function applyLayout(root, config) {
  const layout = config.layout || {};
  const width = String(layout.minCardWidth || "").trim();
  root.style.setProperty(
    "--min-card-width",
    CSS_LENGTH.test(width) ? width : "14rem",
  );
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
  const node = buildNotice(notice);
  const id = node.dataset.noticeId;
  if (id) {
    const previous = parts.notices.querySelector(`[data-notice-id="${CSS.escape(id)}"]`);
    if (previous) previous.remove();
  }
  parts.notices.append(node);
  return node;
}

/**
 * The notice element itself, with no opinion about where it goes.
 *
 * Split out from renderNotice because the diagram panel renders its own
 * notices into its own body: the panel is a sibling of #portal, and a diagram
 * failure must not push the bookmark tree around or ride on the tree's live
 * region.
 */
function buildNotice(notice) {
  const { kind = "info", title, message, hints, links, issues, dismissible, id, actions } =
    notice || {};

  const node = make("div", `notice notice-${kind}`);
  if (id) node.dataset.noticeId = id;

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

/* -------------------------------------------------------------------------
 * 14. The diagram panel
 *
 * #diagram-panel is a sibling of <main>, outside everything that re-renders,
 * for the same reason the frame host is: rebuilding an inlined SVG on every
 * config poll would discard the pan and zoom position and re-run the renderer.
 * Nothing here reparents the panel, and nothing here parses or sanitises a
 * diagram: the model arrives carrying an already-sanitised element, the CSS
 * the sanitiser extracted having already been adopted through the CSSOM by
 * app.js. This module never creates a <style> element, because the page is
 * served under `style-src 'self'`.
 *
 * Pan and zoom are gestures, so the measurement and the arithmetic are here,
 * but the resulting state is not: every change is reported through
 * handlers.onZoom and arrives back in the next model. That is what lets a
 * config change re-render the panel with the position intact.
 * ---------------------------------------------------------------------- */

/**
 * The id of the element the diagram is mounted in, which is also the scope the
 * sanitiser is asked to qualify the extracted CSS with. Exported so app.js
 * passes the same value to sanitizeSvg rather than both sides guessing.
 */
export const DIAGRAM_SCOPE_ID = "qp-diagram-scope";

const DIAGRAM_BODY_ID = "qp-diagram-body";
const DIAGRAM_HINT_ID = "qp-diagram-hint";

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 8;
const ZOOM_STEP = 1.25;
/** Viewport pixels moved by one arrow key; Shift multiplies it. */
const PAN_STEP = 48;

/** Handlers per panel element, replaced on every render. */
const diagramHandlers = new WeakMap();
const boundPanels = new WeakSet();
/** The untransformed size of a mounted diagram, measured once per element. */
const naturalSizes = new WeakMap();

const DIAGRAM_HINT =
  "Drag to pan. Hold Ctrl and scroll to zoom; scrolling on its own moves the page. " +
  "With the diagram focused, the arrow keys pan, + and - zoom, and 0 fits it to the view.";

/**
 * Render the collapsible diagram panel.
 *
 * @param {Element} host  #diagram-panel
 * @param {object} model
 *   {configured, title, open, state, el, dropped, droppedDismissed, error,
 *    zoom, busy, renderer, fallback} - `state` is "idle" | "loading" | "ready" |
 *   "error", `el` is the sanitised SVG element, `zoom` is {scale, x, y} or
 *   null to fit it on first sight, `renderer` only changes the wording while
 *   loading, and `fallback` is set when the committed SVG is being shown
 *   because the renderer module could not be loaded
 * @param {object} handlers
 *   onToggle(open), onZoom({scale, x, y}), onExportSvg(), onExportPng(),
 *   onRetry(), onDismissDrop()
 */
export function renderDiagramPanel(host, model, handlers) {
  if (!host) return;
  diagramHandlers.set(host, handlers || {});
  const m = model || {};

  // No diagram section in the config means no panel at all: an empty frame
  // explaining that nothing is configured is chrome nobody asked for.
  if (!m.configured) {
    setHidden(host, true);
    return;
  }

  const parts = ensureDiagramPanel(host);
  setHidden(host, false);

  setText(parts.name, m.title || "Diagram");
  const open = Boolean(m.open);
  setAttr(parts.toggle, "aria-expanded", open ? "true" : "false");
  setHidden(parts.body, !open);
  // Everything below needs layout to measure against, and a hidden element has
  // none, so a closed panel stops here. Opening it renders again.
  if (!open) return;

  updateDiagramNotices(parts, m);

  const ready = m.state === "ready" && m.el;
  setText(parts.status, diagramStatusLine(m));
  setHidden(parts.status, m.state !== "loading");
  setHidden(parts.toolbar, !ready);
  setHidden(parts.viewport, !ready);
  setHidden(parts.hint, !ready);

  if (!ready) {
    if (parts.canvas.firstChild) parts.canvas.replaceChildren();
    return;
  }

  if (parts.canvas.firstElementChild !== m.el) {
    parts.canvas.replaceChildren(m.el);
    naturalSizes.delete(m.el);
  }

  const zoom = normalizeZoom(m.zoom);
  // A null zoom means "this is the first sight of this diagram": fit it, and
  // report the result so the state lives where a re-render can hand it back.
  if (!zoom) fitDiagram(parts, diagramHandlers.get(host) || {});
  else applyZoom(parts, zoom);

  updateExportState(parts, m.busy);
}

/* ---- structure, built once ---------------------------------------------- */

function ensureDiagramPanel(host) {
  let parts = host.__quickportalDiagram;
  if (parts && parts.body.isConnected) return parts;

  // The section carries aria-labelledby="diagram-title" from index.html, so
  // that id belongs to the heading and nothing else may take it.
  const head = make("h2", "diagram-head");
  head.id = "diagram-title";
  const toggle = make("button", "diagram-toggle");
  toggle.type = "button";
  setAttr(toggle, "aria-controls", DIAGRAM_BODY_ID);
  const chev = make("span", "chev", "▼");
  setAttr(chev, "aria-hidden", "true");
  const name = make("span", "diagram-name");
  toggle.append(chev, name);
  head.append(toggle);

  const body = make("div", "diagram-body");
  body.id = DIAGRAM_BODY_ID;
  body.setAttribute("role", "region");
  setAttr(body, "aria-labelledby", head.id);

  const notices = make("div", "notices diagram-notices");
  notices.setAttribute("aria-live", "polite");

  const status = make("p", "diagram-status");
  status.setAttribute("role", "status");
  status.hidden = true;

  const toolbar = make("div", "diagram-toolbar");
  const zoomLevel = make("p", "diagram-zoom");
  // A live region: the zoom level changes from the wheel and the keyboard as
  // well as from these buttons, and it has to be conveyed either way.
  zoomLevel.setAttribute("role", "status");
  toolbar.append(
    diagramButton("zoom-out", "−", "Zoom out"),
    zoomLevel,
    diagramButton("zoom-in", "+", "Zoom in"),
    diagramButton("fit", "⛶", "Fit"),
    diagramButton("export-svg", "⤓", "Export SVG"),
    diagramButton("export-png", "⤓", "Export PNG"),
  );
  toolbar.hidden = true;

  const viewport = make("div", "diagram-viewport");
  viewport.tabIndex = 0;
  viewport.setAttribute("role", "group");
  setAttr(viewport, "aria-describedby", DIAGRAM_HINT_ID);
  viewport.hidden = true;
  const canvas = make("div", "diagram-canvas");
  canvas.id = DIAGRAM_SCOPE_ID;
  viewport.append(canvas);

  const hint = make("p", "diagram-hint", DIAGRAM_HINT);
  hint.id = DIAGRAM_HINT_ID;
  hint.hidden = true;

  body.append(notices, status, toolbar, viewport, hint);
  host.replaceChildren(head, body);

  parts = { host, head, toggle, name, body, notices, status, toolbar, zoomLevel, viewport, canvas, hint };
  host.__quickportalDiagram = parts;
  attachDiagramListeners(parts);
  return parts;
}

function diagramButton(action, glyph, label) {
  const button = make("button", "btn btn-quiet");
  button.type = "button";
  button.dataset.diagramAction = action;
  const icon = make("span", null, glyph);
  setAttr(icon, "aria-hidden", "true");
  // The label is the first thing a narrow toolbar drops, so the aria-label
  // carries the same words whether or not the text is on screen.
  button.append(icon, make("span", "btn-label", label));
  setAttr(button, "aria-label", label);
  return button;
}

/* ---- notices ------------------------------------------------------------ */

/**
 * The panel's own notices. Keyed by a signature so that a drag, which
 * re-renders on every pointer move, does not rebuild them sixty times a
 * second and restart their live region.
 */
function updateDiagramNotices(parts, m) {
  const dropped = m.droppedDismissed ? null : normalizeDropCounts(m.dropped);
  const error = m.error || null;
  const fallback = m.fallback || null;
  const signature = JSON.stringify([
    error && [error.kind, error.path, error.bytes, error.maxBytes, error.url, error.detail],
    dropped && [dropped.elements, dropped.attributes, dropped.declarations, dropped.rules],
    fallback && [fallback.reason, fallback.url, fallback.path],
  ]);
  if (parts.notices.dataset.signature === signature) return;
  parts.notices.dataset.signature = signature;

  parts.notices.replaceChildren();
  if (error) parts.notices.append(buildNotice(diagramErrorNotice(error)));
  if (fallback) parts.notices.append(buildNotice(diagramFallbackNotice(fallback)));
  if (dropped) parts.notices.append(buildNotice(diagramDropNotice(dropped)));
}

/**
 * The renderer could not be loaded and a committed SVG was shown instead.
 *
 * This is the feature's only graceful degradation, so it says what happened
 * rather than hiding it: the picture on screen was rendered at some earlier
 * point and committed, and it is not necessarily the config's current source.
 */
function diagramFallbackNotice(fallback) {
  const blocked = fallback.reason === "blocked";
  return {
    kind: "info",
    id: "diagram-fallback",
    title: blocked
      ? "Showing the committed diagram: this deployment's policy blocked the renderer"
      : "Showing the committed diagram: the renderer could not be reached",
    message:
      `The diagram below is the SVG committed at ${fallback.path || "diagram.src"}, ` +
      `rendered earlier rather than now. ` +
      (blocked
        ? `QuickPortal's own Content-Security-Policy refused to import ` +
          `${fallback.url || "the renderer"}, so the source in the config was not re-rendered.`
        : `${fallback.url || "The renderer"} could not be loaded, so the source in the ` +
          `config was not re-rendered.`) +
      " If the two have drifted apart, this is the older of them.",
    hints: blocked
      ? [
          "Widen script-src in the server config ConfigMap to list the renderer's origin; it ships as script-src 'self'.",
          "Re-rendering to SVG in CI and committing the result keeps the two in step with no policy change at all.",
        ]
      : [
          "On a machine with no route to that origin this is what you get, which is the point of committing the SVG as well.",
          "Re-rendering to SVG in CI and committing the result keeps the two in step with no origin to reach.",
        ],
    dismissible: true,
  };
}

function normalizeDropCounts(dropped) {
  if (!dropped) return null;
  const elements = countOf(dropped.elements);
  const attributes = countOf(dropped.attributes);
  const declarations = countOf(dropped.declarations);
  const rules = countOf(dropped.rules);
  if (!(elements + attributes + declarations + rules)) return null;
  return { elements, attributes, declarations, rules };
}

function countOf(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

/**
 * "3 elements, 5 attributes and 2 style declarations", skipping the zeroes.
 */
function dropSummary(dropped) {
  const parts = [];
  if (dropped.elements) parts.push(plural(dropped.elements, "element"));
  if (dropped.attributes) parts.push(plural(dropped.attributes, "attribute"));
  if (dropped.declarations) parts.push(plural(dropped.declarations, "style declaration"));
  if (dropped.rules) parts.push(plural(dropped.rules, "style rule"));
  if (parts.length < 2) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Silently altering someone's diagram is worse than telling them, so this is
 * a notice rather than a console line, and the diagram still renders below it.
 */
function diagramDropNotice(dropped) {
  return {
    kind: "warn",
    id: "diagram-dropped",
    title: `The diagram was altered: ${dropSummary(dropped)} removed`,
    message:
      "It is displayed below without them. An SVG is executable content, so it " +
      "is rebuilt against an allowlist before it enters the page rather than " +
      "pasted in as markup.",
    hints: dropped && dropped.foreignObjects > 0
      ? [
          "Labels are probably missing. The renderer put them in HTML inside a foreignObject, which is removed because it is a way to get HTML into this page.",
          "For mermaid, set htmlLabels: false at the top level AND under the diagram type (for example flowchart.htmlLabels: false). One without the other is not enough: it still emits foreignObject and the labels still vanish.",
          "Everything else removed: scripts, on* handlers, animation elements, base elements, external references and CSS carrying url(), @import, expression() or behavior:.",
        ]
      : [
          "Scripts, on* handlers, foreignObject, animation elements, base elements, external references and CSS carrying url(), @import, expression() or behavior: are all removed.",
          "If the diagram looks wrong, re-export it without those constructs rather than working around the allowlist.",
        ],
    dismissible: true,
  };
}

/**
 * Every failure is a notice, and every notice names the specific thing to
 * look at: the path that was tried, the two sizes, the parse error, the origin
 * the diagram needs, or our own policy.
 */
function diagramErrorNotice(error) {
  const path = error.path || "the configured path";
  const detail = error.detail ? ` ${error.detail}` : "";
  const retry = { action: "retry", label: "Try again", primary: true };
  const unaffected = "The bookmarks are unaffected.";

  switch (error.kind) {
    case "missing":
      return {
        kind: "error",
        id: "diagram-error",
        title: "The diagram could not be fetched",
        message: `Nothing usable came back from ${path}.${detail} ${unaffected}`,
        hints: [
          "The diagram is a key in the same ConfigMap as config.yaml, and diagram.src is the path it is served at.",
          "A ConfigMap mounted with subPath is never updated by kubelet, and an immutable ConfigMap never changes at all.",
        ],
        actions: [retry],
      };

    case "too-large":
      return {
        kind: "error",
        id: "diagram-error",
        title: "The diagram is over the size limit",
        message:
          `${path} is ${formatBytes(error.bytes)} and the limit is ` +
          `${formatBytes(error.maxBytes)}, so it was not inlined. ${unaffected}`,
        hints: [
          "Raise diagram.maxBytes if the file is genuinely that big and the page can afford it.",
          "The diagram shares the 1MiB ConfigMap with the config, and inlining a megabyte of SVG is slow on a phone long before the cluster refuses it.",
        ],
        actions: [retry],
      };

    case "parse":
      return {
        kind: "error",
        id: "diagram-error",
        title: "The diagram is not valid SVG",
        message: `${path} could not be parsed as SVG.${detail} ${unaffected}`,
        hints: [
          "It is parsed as image/svg+xml, which is XML: an unclosed tag or a stray & is fatal where HTML would have recovered.",
          "Open the file in a browser on its own; the same parser reports the same error.",
        ],
        actions: [retry],
      };

    case "renderer-unreachable":
      return {
        kind: "error",
        id: "diagram-error",
        title: `The diagram needs ${error.origin || "the renderer's origin"}`,
        message:
          `The diagram source in the config is drawn by a renderer module this ` +
          `project does not ship, imported from ${error.url || "the configured URL"} ` +
          `when the panel is opened. That origin could not be reached.${detail} ${unaffected}`,
        hints: [
          "On a machine with no route to that origin, the diagram cannot be drawn at all; this is the cost of the renderer hook, stated where it bites.",
          "Rendering the diagram to SVG once and setting diagram.src instead needs no origin and no policy change.",
          "Self-hosting the renderer beside the portal is better than a public CDN for exactly this reason.",
        ],
        actions: [retry],
      };

    case "renderer-blocked":
      return {
        kind: "error",
        id: "diagram-error",
        title: "This deployment's own policy is blocking the diagram renderer",
        message:
          `QuickPortal's Content-Security-Policy refused to import ` +
          `${error.url || "the renderer"}. This is the portal's own header, not the ` +
          `renderer's: naming a renderer in the config is only half of it. ${unaffected}`,
        hints: [
          "Widen script-src in the server config ConfigMap to list the renderer's origin; it ships as script-src 'self'.",
          "This is the same half-configured state as frame-src for embedding, and it takes the same deployment-level change.",
          "Until the policy allows it, render the diagram to SVG and set diagram.src, which needs no policy change at all.",
        ],
      };

    case "render-failed":
      return {
        kind: "error",
        id: "diagram-error",
        title: "The renderer could not draw the diagram",
        message:
          `The renderer loaded but did not return an SVG for the source in the ` +
          `config.${detail} ${unaffected}`,
        hints: [
          "The source is passed through verbatim, so a syntax error in it is reported by the renderer, not by the portal.",
          "A renderer told to trust its input will emit constructs the sanitiser then removes; securityLevel: strict is the setting worth keeping.",
        ],
        actions: [retry],
      };

    default:
      return {
        kind: "error",
        id: "diagram-error",
        title: "The diagram could not be shown",
        message: `${detail.trim() || "No diagram source is configured."} ${unaffected}`,
        actions: [retry],
      };
  }
}

/** KiB for anything over a kilobyte, with the exact byte count kept. */
function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "an unknown size";
  if (value < 1024) return `${value} bytes`;
  const kib = value / 1024;
  const scaled = kib < 1024 ? `${kib.toFixed(1)} KiB` : `${(kib / 1024).toFixed(2)} MiB`;
  return `${scaled} (${value.toLocaleString("en")} bytes)`;
}

function diagramStatusLine(m) {
  if (m.state === "loading") {
    return m.renderer
      ? "Rendering the diagram…"
      : "Loading the diagram…";
  }
  return "";
}

/* ---- zoom and pan ------------------------------------------------------- */

function normalizeZoom(zoom) {
  if (!zoom) return null;
  const scale = Number(zoom.scale);
  const x = Number(zoom.x);
  const y = Number(zoom.y);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  return {
    scale: clampScale(scale),
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
  };
}

function clampScale(scale) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));
}

/**
 * Write the transform through the CSSOM and keep the zoom readout in step.
 * This is element.style, not a style attribute in the markup, which is what
 * keeps the page on `style-src 'self'`.
 */
function applyZoom(parts, zoom) {
  parts.canvas.style.setProperty(
    "transform",
    `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`,
  );
  const percent = `${Math.round(zoom.scale * 100)}%`;
  setText(parts.zoomLevel, `Zoom ${percent}`);
  setAttr(
    parts.viewport,
    "aria-label",
    `Diagram, zoomed to ${percent}. Pan and zoom from the keyboard.`,
  );
  const out = parts.toolbar.querySelector('[data-diagram-action="zoom-out"]');
  const into = parts.toolbar.querySelector('[data-diagram-action="zoom-in"]');
  setDisabled(out, zoom.scale <= ZOOM_MIN + 1e-9);
  setDisabled(into, zoom.scale >= ZOOM_MAX - 1e-9);
}

function setDisabled(node, disabled) {
  if (node && node.disabled !== disabled) node.disabled = disabled;
}

function updateExportState(parts, busy) {
  const svg = parts.toolbar.querySelector('[data-diagram-action="export-svg"]');
  const png = parts.toolbar.querySelector('[data-diagram-action="export-png"]');
  setDisabled(svg, busy === "svg");
  setDisabled(png, busy === "png");
  setAttr(parts.toolbar, "aria-busy", busy ? "true" : null);
}

function currentZoom(parts) {
  const match = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([-\d.]+)\)/.exec(
    parts.canvas.style.transform || "",
  );
  if (!match) return { scale: 1, x: 0, y: 0 };
  return { x: Number(match[1]), y: Number(match[2]), scale: clampScale(Number(match[3])) };
}

/**
 * The diagram's size with no transform applied, measured once per element.
 *
 * Measuring the transformed box and dividing is tempting and wrong: the scale
 * is the thing being solved for. So the transform is removed for the length of
 * one read. It happens on a fit, not on a drag.
 */
function naturalSize(parts, el) {
  const cached = naturalSizes.get(el);
  if (cached) return cached;
  const previous = parts.canvas.style.transform;
  parts.canvas.style.setProperty("transform", "none");
  const rect = el.getBoundingClientRect();
  if (previous) parts.canvas.style.setProperty("transform", previous);
  else parts.canvas.style.removeProperty("transform");
  const size = { width: rect.width || 0, height: rect.height || 0 };
  if (size.width > 0 && size.height > 0) naturalSizes.set(el, size);
  return size;
}

/**
 * Fit the whole diagram in the viewport and centre it. Reported through
 * onZoom like any other change, so the next model carries it.
 */
function fitDiagram(parts, handlers) {
  const el = parts.canvas.firstElementChild;
  if (!el) return;
  const vw = parts.viewport.clientWidth;
  const vh = parts.viewport.clientHeight;
  const size = naturalSize(parts, el);
  if (!(vw > 0 && vh > 0 && size.width > 0 && size.height > 0)) {
    commitZoom(parts, { scale: 1, x: 0, y: 0 }, handlers);
    return;
  }
  // A little short of exact, so the outermost stroke is not clipped by a
  // rounding error.
  const scale = clampScale(Math.min(vw / size.width, vh / size.height) * 0.96);
  commitZoom(
    parts,
    {
      scale,
      x: (vw - size.width * scale) / 2,
      y: (vh - size.height * scale) / 2,
    },
    handlers,
  );
}

/**
 * Zoom by a factor about a fixed point in viewport coordinates, so the thing
 * under the pointer (or the centre of the view, for a button) stays put.
 */
function zoomBy(parts, factor, originX, originY, handlers) {
  const zoom = currentZoom(parts);
  const next = clampScale(zoom.scale * factor);
  if (next === zoom.scale) return;
  const k = next / zoom.scale;
  commitZoom(
    parts,
    {
      scale: next,
      x: originX - k * (originX - zoom.x),
      y: originY - k * (originY - zoom.y),
    },
    handlers,
  );
}

function panBy(parts, dx, dy, handlers) {
  const zoom = currentZoom(parts);
  commitZoom(parts, { scale: zoom.scale, x: zoom.x + dx, y: zoom.y + dy }, handlers);
}

/**
 * Apply a new position immediately and report it.
 *
 * Applied here as well as reported because a drag has to track the pointer
 * whether or not the owner re-renders, and because applying the same numbers
 * twice is idempotent. The report is what survives a config change.
 */
function commitZoom(parts, zoom, handlers) {
  const next = normalizeZoom(zoom) || { scale: 1, x: 0, y: 0 };
  applyZoom(parts, next);
  if (handlers && typeof handlers.onZoom === "function") handlers.onZoom(next);
}

function viewportCentre(parts) {
  return { x: parts.viewport.clientWidth / 2, y: parts.viewport.clientHeight / 2 };
}

/* ---- events ------------------------------------------------------------- */

function attachDiagramListeners(parts) {
  const host = parts.host;
  if (boundPanels.has(host)) return;
  boundPanels.add(host);

  host.addEventListener("click", (event) => {
    const handlers = diagramHandlers.get(host) || {};

    const toggle = event.target.closest(".diagram-toggle");
    if (toggle) {
      const open = toggle.getAttribute("aria-expanded") === "true";
      if (typeof handlers.onToggle === "function") handlers.onToggle(!open);
      return;
    }

    const dismiss = event.target.closest('[data-action="dismiss-notice"]');
    if (dismiss) {
      // The notice is about to vanish with the button that was activated, so
      // focus is moved on purpose rather than dropped on the document.
      const landing = parts.toolbar.querySelector('[data-diagram-action="fit"]') || parts.toggle;
      call(handlers.onDismissDrop);
      if (landing && landing.isConnected) landing.focus({ preventScroll: true });
      return;
    }

    if (event.target.closest('[data-action="retry"]')) {
      call(handlers.onRetry);
      return;
    }

    const button = event.target.closest("[data-diagram-action]");
    if (!button) return;
    const centre = viewportCentre(parts);
    switch (button.dataset.diagramAction) {
      case "zoom-in":
        zoomBy(parts, ZOOM_STEP, centre.x, centre.y, handlers);
        break;
      case "zoom-out":
        zoomBy(parts, 1 / ZOOM_STEP, centre.x, centre.y, handlers);
        break;
      case "fit":
        fitDiagram(parts, handlers);
        break;
      case "export-svg":
        call(handlers.onExportSvg);
        break;
      case "export-png":
        call(handlers.onExportPng);
        break;
      default:
        break;
    }
  });

  parts.viewport.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const handlers = diagramHandlers.get(host) || {};
    const step = event.shiftKey ? PAN_STEP * 4 : PAN_STEP;
    const centre = viewportCentre(parts);

    switch (event.key) {
      // Panning moves the diagram the way the key points, so ArrowRight
      // reveals what is off the right edge.
      case "ArrowLeft":
        event.preventDefault();
        panBy(parts, step, 0, handlers);
        break;
      case "ArrowRight":
        event.preventDefault();
        panBy(parts, -step, 0, handlers);
        break;
      case "ArrowUp":
        event.preventDefault();
        panBy(parts, 0, step, handlers);
        break;
      case "ArrowDown":
        event.preventDefault();
        panBy(parts, 0, -step, handlers);
        break;
      case "+":
      case "=":
      case "Add":
        event.preventDefault();
        zoomBy(parts, ZOOM_STEP, centre.x, centre.y, handlers);
        break;
      case "-":
      case "_":
      case "Subtract":
        event.preventDefault();
        zoomBy(parts, 1 / ZOOM_STEP, centre.x, centre.y, handlers);
        break;
      case "0":
      case "Home":
        event.preventDefault();
        fitDiagram(parts, handlers);
        break;
      default:
        break;
    }
  });

  // Not passive, because a Ctrl-wheel is preventDefault'ed to stop the browser
  // zooming the whole page instead. A plain wheel is deliberately left alone:
  // a panel that swallowed the scroll wheel would trap someone scrolling past
  // it on the way to the bookmarks.
  parts.viewport.addEventListener(
    "wheel",
    (event) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const handlers = diagramHandlers.get(host) || {};
      const rect = parts.viewport.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY * 0.0025);
      zoomBy(parts, factor, event.clientX - rect.left, event.clientY - rect.top, handlers);
    },
    { passive: false },
  );

  // Mouse and pen only. A touch drag is left to the browser so that the page
  // still scrolls under a finger; touch users zoom with the buttons and with
  // their own pinch gesture on the page.
  let drag = null;

  parts.viewport.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (event.pointerType !== "mouse" && event.pointerType !== "pen") return;
    if (event.target.closest("button, a")) return;
    const zoom = currentZoom(parts);
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, zoom };
    parts.viewport.dataset.dragging = "true";
    try {
      parts.viewport.setPointerCapture(event.pointerId);
    } catch {
      // Capture is a convenience; the move listener still works without it.
    }
  });

  parts.viewport.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    event.preventDefault();
    const handlers = diagramHandlers.get(host) || {};
    commitZoom(
      parts,
      {
        scale: drag.zoom.scale,
        x: drag.zoom.x + (event.clientX - drag.x),
        y: drag.zoom.y + (event.clientY - drag.y),
      },
      handlers,
    );
  });

  function endDrag(event) {
    if (!drag || (event && event.pointerId !== drag.id)) return;
    drag = null;
    delete parts.viewport.dataset.dragging;
  }

  parts.viewport.addEventListener("pointerup", endDrag);
  parts.viewport.addEventListener("pointercancel", endDrag);
  parts.viewport.addEventListener("lostpointercapture", endDrag);
}
