// Opening a named set of bookmarks in one action.
//
// The hard constraint here is the browser's popup blocker: a user gesture only
// carries to window.open calls that happen in the same synchronous call stack as
// the click. One await, one setTimeout, one promise between two opens and the
// browser blocks everything after the first. So openSet is synchronous end to
// end, and every helper it uses is synchronous too. Do not make this async.

/** A set resolving to more than this many targets asks for confirmation first. */
// config.js owns the one and only resolveTargets. It is imported statically,
// not dynamically, because an await anywhere before the window.open calls
// would destroy the user gesture and the browser would block every tab.
// Re-exported so callers have a single place to get it from.
import { resolveTargets } from './config.js';

export { resolveTargets };

export const SET_CONFIRM_THRESHOLD = 10;

/**
 * Open every target of a set.
 *
 * @param {object} set     a set from the config: {id, name, targets: string[]}
 * @param {object} config  the normalized config, used to resolve target ids
 * @param {object} [deps]  injected browser bits, for tests:
 *   open(url, target) -> window-like or null   (default window.open)
 *   confirm(message) -> boolean                (default window.confirm)
 *   resolveTargets(set, config) -> {items, unresolved}
 *                                              (default: the local fallback below;
 *                                               app.js passes config.js's version)
 * @returns {{opened: number, blocked: object[], confirmed: boolean}}
 *   `blocked` holds the item objects the browser refused, so the caller can
 *   render them as plain links. `confirmed` is false only when a large set was
 *   declined, which lets the UI tell "you cancelled" from "nothing opened".
 */
export function openSet(set, config, deps = {}) {
  const open = deps.open ?? defaultOpen;
  const confirm = deps.confirm ?? defaultConfirm;
  const resolve = deps.resolveTargets ?? resolveTargets;

  const { items } = resolve(set, config);

  if (items.length > SET_CONFIRM_THRESHOLD && !confirm(confirmMessage(set, items.length))) {
    return { opened: 0, blocked: [], confirmed: false };
  }

  const blocked = [];
  let opened = 0;

  // Synchronous loop, deliberately. See the note at the top of the file.
  for (const item of items) {
    const handle = open(item.url, item.target ?? '_blank');
    if (handle) {
      opened += 1;
    } else {
      blocked.push(item);
    }
  }

  return { opened, blocked, confirmed: true };
}

/** The message shown before opening a large set. */
export function confirmMessage(set, count) {
  const name = set?.name ?? set?.id ?? 'this set';
  return `"${name}" will open ${count} tabs. Continue?`;
}

function defaultOpen(url, target) {
  return window.open(url, target, 'noopener');
}

function defaultConfirm(message) {
  return window.confirm(message);
}
