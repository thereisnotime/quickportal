/**
 * render.js - everything that touches the DOM inside the portal root.
 *
 * Public surface (the contract in design.md):
 *   renderPortal(root, config, handlers)
 *   renderIssues(root, errors, warnings)
 *   applyFilter(root, query) -> matchCount
 * Plus two helpers app.js needs: renderNotice(root, notice) to report set
 * results, and setCollapsedAll(root, collapsed) for expand-all/collapse-all.
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
    if (card && root.contains(card) && typeof current.onOpenItem === "function") {
      current.onOpenItem(itemForElement.get(card));
    }
  });
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
  li.dataset.search = searchHaystack(item);
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
