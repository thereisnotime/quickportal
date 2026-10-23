// The frame host: every embedded app's <iframe> is created here and nowhere
// else.
//
// One rule dominates this file. Moving an <iframe> in the DOM reloads it, in
// every browser, and a reload throws away whatever the user had inside: a
// half-written form, an open console, a playing stream. So a frame element is
// created once, appended once, and after that only its visibility and a couple
// of attributes ever change. Nothing here reparents, re-appends, removes and
// re-adds, or reassigns `src` except `refresh()`, which is always something the
// user asked for.
//
// That is also why #frame-host is a sibling of <main id="portal"> rather than a
// descendant: render.js reconciles inside #portal, and a reconciliation that
// touched a frame would be an invisible data-loss bug.
//
// Hiding a frame (the contract the view layer's CSS depends on):
//
//   - The focused frame carries `data-active="true"`.
//   - Every other mounted frame carries `data-active="false"`, plus
//     `aria-hidden="true"` and `inert`, and is hidden with an inline
//     `display: none` set through the CSSOM.
//   - `display: none` keeps the document loaded and the session alive. What
//     would *not* be acceptable, and is therefore never done here: removing the
//     element, setting `src=""`, or putting `hidden` on #frame-host while
//     frames are mounted.
//   - #frame-host itself only gets `hidden` while no frame is mounted, when
//     there is nothing left to unload.
//
// Suggested CSS, matching the above:
//
//   #frame-host .frame { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
//   #frame-host .frame[data-active='false'] { display: none; }
//
// The module knows nothing about rendering. The strip is drawn by the view
// layer from `host.list()` and the `onChange` callback.

// The cap and its sanity bound are owned by config.js, which validates
// `embedding.maxFrames` against them. Imported rather than redeclared: two
// copies of the same default would drift. Re-exported so callers that only
// talk to the frame host have one place to read it from.
import { FRAME_DEFAULT_MAX, FRAME_MAX } from './config.js';

export { FRAME_DEFAULT_MAX, FRAME_MAX };

/**
 * How long after mounting a frame is considered to have shown nothing useful.
 *
 * We cannot tell whether a cross-origin frame loaded, was refused, is slow or
 * is down: the parent document can read none of that. So this timer is not a
 * diagnosis and there is no detection anywhere in this file. It only marks the
 * entry `nudged`, which the view layer uses to offer the "open in a browser
 * tab" escape hatch with *possible* causes. It is dismissible per frame
 * (`dismissNudge`), because a merely slow app must not be accused.
 */
export const FRAME_NUDGE_DELAY_MS = 6000;

const ACTIVE = 'data-active';

/**
 * Create the frame host.
 *
 * @param {object} hostEl  the #frame-host element. Must live outside anything
 *                         that re-renders; see the comment in src/index.html.
 * @param {object} [options]
 *   maxFrames  cap on mounted frames, default FRAME_DEFAULT_MAX
 *   onChange   called with host.list() after every change; the only thing the
 *              strip should render from
 *   nudgeDelayMs  override FRAME_NUDGE_DELAY_MS
 *   deps       injected browser bits so this module imports in plain Node:
 *                document, setTimeout, clearTimeout, now(), confirm(message)
 * @returns {object} host
 */
export function createFrameHost(hostEl, options = {}) {
  const deps = options.deps ?? {};
  const doc = deps.document ?? ownerDocumentOf(hostEl) ?? globalDocument();
  const startTimer = deps.setTimeout ?? globalThis.setTimeout;
  const cancelTimer = deps.clearTimeout ?? globalThis.clearTimeout;
  const now = deps.now ?? (() => Date.now());
  const askUser = typeof deps.confirm === 'function' ? deps.confirm : null;
  const onChange = typeof options.onChange === 'function' ? options.onChange : null;
  const nudgeDelayMs = toDelay(options.nudgeDelayMs, FRAME_NUDGE_DELAY_MS);

  // Mount order, which is strip order. Entries are never reordered, because the
  // strip must not shuffle under the user's cursor and because the array index
  // is the only ordering the DOM and the list agree on.
  const entries = [];
  let max = toMax(options.maxFrames, FRAME_DEFAULT_MAX);
  let focusedId = null;
  let destroyed = false;

  function find(id) {
    const key = toId(id);
    if (key === null) return null;
    return entries.find((entry) => entry.id === key) ?? null;
  }

  function list() {
    return entries.map((entry) => ({
      id: entry.id,
      item: entry.item,
      focused: entry.id === focusedId,
      mountedAt: entry.mountedAt,
      lastFocusedAt: entry.lastFocusedAt,
      nudged: entry.nudged,
    }));
  }

  function emit() {
    if (!onChange) return;
    try {
      onChange(list());
    } catch {
      // A broken view must not corrupt the host, and must certainly not leave
      // a frame half-mounted. Swallowed on purpose.
    }
  }

  // --- visibility -----------------------------------------------------------
  // The only thing allowed to change about a mounted frame.

  function paint() {
    for (const entry of entries) {
      const active = entry.id === focusedId;
      entry.el.setAttribute(ACTIVE, active ? 'true' : 'false');
      if (active) {
        entry.el.removeAttribute('aria-hidden');
        entry.el.removeAttribute('inert');
        removeDisplayNone(entry.el);
      } else {
        entry.el.setAttribute('aria-hidden', 'true');
        entry.el.setAttribute('inert', '');
        setDisplayNone(entry.el);
      }
    }
    // Only ever hidden when there is nothing mounted to unload.
    if (entries.length === 0) hostEl?.setAttribute?.('hidden', '');
    else hostEl?.removeAttribute?.('hidden');
  }

  // --- the frame element ----------------------------------------------------

  function buildFrame(item) {
    const el = doc.createElement('iframe');
    el.setAttribute('class', 'frame');
    el.setAttribute('data-frame-id', item.id);
    el.setAttribute('title', String(item.name ?? item.id));

    // Deliberate, not inherited by accident:
    //
    // referrerpolicy="no-referrer" — the page already sends
    // <meta name="referrer" content="no-referrer">, and the portal's own URL
    // (which leaks the operator's internal hostname) is of no use to the
    // embedded app. An app that needs a referrer to work is not a case we
    // break: it never had one from this page anyway.
    el.setAttribute('referrerpolicy', 'no-referrer');

    // loading="eager" — a frame is only ever mounted because the user asked
    // for it, and an unfocused frame is display:none, which is exactly the
    // condition under which "lazy" lets the browser defer the load
    // indefinitely. A restored or background tab that never starts loading
    // until it is looked at would be worse than useless: the point of
    // embedding is that the app is already up when you switch to it.
    el.setAttribute('loading', 'eager');

    // `allow` only when there is something to allow; an empty attribute is
    // meaningless noise. `sandbox` only when the item asked for it, because an
    // empty sandbox attribute is maximally restrictive (no scripts, no forms,
    // no storage, opaque origin) and would break every real app.
    const allow = joinTokens(item.allow, '; ');
    if (allow) el.setAttribute('allow', allow);
    const sandbox = joinTokens(item.sandbox, ' ');
    if (sandbox) el.setAttribute('sandbox', sandbox);

    // Last, and the only assignment to src outside refresh().
    el.setAttribute('src', item.url);
    return el;
  }

  function navigate(entry) {
    // The one place a reload is allowed. Assigning the property (rather than
    // only the attribute) is what makes the browser navigate even when the URL
    // is unchanged, which is the whole point of "refresh".
    entry.el.setAttribute('src', entry.item.url);
    try {
      entry.el.src = entry.item.url;
    } catch {
      // Exotic element stand-ins may not take the property; the attribute is
      // already set.
    }
    entry.reloads += 1;
    armNudge(entry);
  }

  // --- the "nothing has appeared" timer -------------------------------------

  function armNudge(entry) {
    clearNudge(entry);
    entry.nudged = false;
    if (!nudgeDelayMs) return;
    entry.timer = startTimer(() => {
      entry.timer = null;
      if (destroyed || entry.closed) return;
      entry.nudged = true;
      emit();
    }, nudgeDelayMs);
  }

  function clearNudge(entry) {
    if (entry.timer === null || entry.timer === undefined) return;
    cancelTimer(entry.timer);
    entry.timer = null;
  }

  // --- mount / unmount ------------------------------------------------------

  function mount(item, { focus = true } = {}) {
    const el = buildFrame(item);
    const entry = {
      id: item.id,
      item,
      el,
      mountedAt: now(),
      lastFocusedAt: 0,
      nudged: false,
      reloads: 0,
      timer: null,
      closed: false,
    };
    entries.push(entry);
    hostEl.appendChild(el); // Once. Never again for this element.
    armNudge(entry);
    if (focus) {
      focusedId = entry.id;
      entry.lastFocusedAt = now();
    } else if (entry.lastFocusedAt === 0) {
      // Never focused, but it still needs an ordering for eviction: treat the
      // mount as the last time anyone cared about it.
      entry.lastFocusedAt = entry.mountedAt;
    }
    return entry;
  }

  function unmount(entry) {
    clearNudge(entry);
    entry.closed = true;
    const index = entries.indexOf(entry);
    if (index !== -1) entries.splice(index, 1);
    // Removal is the one destructive DOM operation here, and it is only ever
    // the consequence of a close the caller asked for.
    entry.el.remove?.();
    if (focusedId === entry.id) focusedId = null;
    return { id: entry.id, item: entry.item };
  }

  /** The least recently focused mounted frame, which is what eviction takes. */
  function leastRecentlyFocused() {
    let worst = null;
    for (const entry of entries) {
      if (entry.id === focusedId) continue; // Never evict what is on screen.
      if (!worst || entry.lastFocusedAt < worst.lastFocusedAt) worst = entry;
    }
    return worst ?? entries[0] ?? null;
  }

  function refocusAfterClose() {
    if (focusedId !== null || entries.length === 0) return;
    // Fall back to the most recently focused survivor.
    let best = entries[0];
    for (const entry of entries) {
      if (entry.lastFocusedAt > best.lastFocusedAt) best = entry;
    }
    focusedId = best.id;
    best.lastFocusedAt = now();
  }

  // --- public API -----------------------------------------------------------

  const host = {
    /**
     * Mount an item, or focus it if it is already mounted.
     *
     * @param {object} item  a normalized config item: {id, name, url, allow?, sandbox?}
     * @returns {{mounted: boolean, focused: boolean, evicted: null|{id, item}}}
     *   `evicted` is non-null only when the cap forced a close, so the caller
     *   can name what it closed. Focusing something already open never evicts.
     */
    open(item) {
      const result = { mounted: false, focused: false, evicted: null };
      if (destroyed || !isMountable(item)) return result;

      const existing = find(item.id);
      if (existing) {
        // Already mounted: focus only. No new element, no navigation, no
        // eviction, and in particular no reload, which is what makes
        // re-activating a bookmark safe.
        focusedId = existing.id;
        existing.lastFocusedAt = now();
        existing.item = item; // A renamed item keeps its live frame.
        paint();
        emit();
        return { mounted: false, focused: true, evicted: null };
      }

      // One eviction per open, even when the count is over the cap (which
      // setMax can leave it), because closing several apps for one click would
      // be a hostile surprise. See setMax.
      if (entries.length >= max) {
        const victim = leastRecentlyFocused();
        if (victim) result.evicted = unmount(victim);
      }

      mount(item, { focus: true });
      result.mounted = true;
      result.focused = true;
      paint();
      emit();
      return result;
    },

    /**
     * Show a mounted frame. Touches nothing but visibility.
     *
     * @returns {boolean} whether there was such a frame
     */
    focus(id) {
      if (destroyed) return false;
      const entry = find(id);
      if (!entry) return false;
      if (focusedId === entry.id) {
        entry.lastFocusedAt = now();
        return true;
      }
      focusedId = entry.id;
      entry.lastFocusedAt = now();
      paint();
      emit();
      return true;
    },

    /**
     * Close one frame. Destroys whatever was inside it, by definition.
     *
     * @returns {null|{id, item}} what was closed
     */
    close(id) {
      if (destroyed) return null;
      const entry = find(id);
      if (!entry) return null;
      const closed = unmount(entry);
      refocusAfterClose();
      paint();
      emit();
      return closed;
    },

    /**
     * Close every frame.
     *
     * The host does not prompt on its own: pass a confirm function (here or as
     * `deps.confirm`) to get the "this closes N apps" guard, which is what the
     * view layer does for the keyboard and palette paths. Without one it
     * closes, so a programmatic caller is never blocked on a dialog.
     *
     * @returns {{closed: Array<{id, item}>, confirmed: boolean}}
     */
    closeAll(opts = {}) {
      if (destroyed) return { closed: [], confirmed: true };
      const confirmFn = typeof opts.confirm === 'function' ? opts.confirm : askUser;
      if (entries.length > 1 && confirmFn) {
        const count = entries.length;
        const message = `Close ${count} open apps? Anything unsaved in them is lost.`;
        if (!confirmFn(message)) return { closed: [], confirmed: false };
      }
      const closed = [];
      for (const entry of [...entries]) closed.push(unmount(entry));
      focusedId = null;
      paint();
      emit();
      return { closed, confirmed: true };
    },

    /**
     * Reload one frame. The only operation that reassigns `src`, and always
     * because someone asked.
     *
     * @returns {boolean} whether there was such a frame
     */
    refresh(id) {
      if (destroyed) return false;
      const entry = find(id);
      if (!entry) return false;
      navigate(entry);
      emit();
      return true;
    },

    /**
     * Reload every mounted frame. Closes nothing.
     *
     * @returns {number} how many were reloaded
     */
    refreshAll() {
      if (destroyed) return 0;
      for (const entry of entries) navigate(entry);
      if (entries.length) emit();
      return entries.length;
    },

    /**
     * Mount a remembered set of ids, from scratch.
     *
     * Ids that are no longer in the config are skipped silently: a tab the user
     * had forgotten about is not worth an error message. Mounts stop at the
     * cap, and nothing is ever evicted to make room for a restore, because the
     * user did not ask for this.
     *
     * @param {string[]} ids           remembered ids, in strip order
     * @param {Map|object} itemsById   the current items, by id
     * @returns {{mounted: string[], skipped: string[]}}
     */
    restore(ids, itemsById) {
      const mounted = [];
      const skipped = [];
      if (destroyed) return { mounted, skipped };

      for (const raw of Array.isArray(ids) ? ids : []) {
        const id = toId(raw);
        if (id === null || find(id) || mounted.includes(id)) {
          if (id !== null) skipped.push(id);
          continue;
        }
        const item = lookup(itemsById, id);
        // Gone from the config, or no longer an embeddable item: skip, keep
        // quiet, and let the caller forget the stored entry.
        if (!isMountable(item) || item.embed === false || entries.length >= max) {
          skipped.push(id);
          continue;
        }
        mount(item, { focus: false });
        mounted.push(id);
      }

      if (mounted.length && focusedId === null) {
        // Focus the leftmost restored tab. Which tab was focused before the
        // reload is not remembered, so anything else would be a guess.
        focusedId = entries[0].id;
        entries[0].lastFocusedAt = now();
      }
      paint();
      if (mounted.length) emit();
      return { mounted, skipped };
    },

    /**
     * Close the tabs whose items have disappeared from the config.
     *
     * A live reload can delete an item out from under a mounted frame. The
     * frame itself survives a re-render untouched, but an app that is no longer
     * in the config should not keep a tab, so the caller closes them here and
     * says why in its own notice.
     *
     * @param {Map|object} itemsById
     * @returns {Array<{id, item}>} what was closed
     */
    pruneMissing(itemsById) {
      if (destroyed) return [];
      const closed = [];
      for (const entry of [...entries]) {
        if (lookup(itemsById, entry.id)) continue;
        closed.push(unmount(entry));
      }
      if (closed.length) {
        refocusAfterClose();
        paint();
        emit();
      }
      return closed;
    },

    /** Stop offering the escape-hatch overlay for one frame. */
    dismissNudge(id) {
      const entry = find(id);
      if (!entry || !entry.nudged) return false;
      entry.nudged = false;
      clearNudge(entry);
      emit();
      return true;
    },

    /** @returns {Array<object>} the strip, in strip order. */
    list,

    has(id) {
      return find(id) !== null;
    },

    count() {
      return entries.length;
    },

    get max() {
      return max;
    },

    /**
     * Change the cap.
     *
     * Lowering it below the current count closes nothing. Evicting several
     * apps because a number changed would destroy work the user never offered
     * up, so the count is allowed to sit above the cap (the strip can say
     * "6 / 2" honestly) and drains by one per subsequent open, which is the
     * same one-eviction-per-action rule as everywhere else. Raising it is
     * clamped to FRAME_MAX, the bound config.js already enforces.
     *
     * @returns {number} the cap now in force
     */
    setMax(n) {
      const next = toMax(n, max);
      if (next === max) return max;
      max = next;
      emit();
      return max;
    },

    /** @returns {string|null} the focused id. */
    focusedId() {
      return focusedId;
    },

    /** Remove every frame, timer and listener. Idempotent. */
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const entry of [...entries]) unmount(entry);
      focusedId = null;
      hostEl?.setAttribute?.('hidden', '');
      emit();
    },
  };

  paint();
  return host;
}

/**
 * Report CSP violations that concern `frame-src`.
 *
 * This sees *our own* Content-Security-Policy refusing to load a frame, which
 * is a real, knowable, and very likely half-configured state: an item opts into
 * embedding while the deployment still sends `frame-src 'none'`.
 *
 * It says nothing whatsoever about whether the target allows framing. That is
 * unknowable from here, and no signal for it exists anywhere in this module by
 * design: a wrong accusation sends someone to edit headers for no reason.
 *
 * @param {function} onBlocked  called with {blockedURI, directive, event}
 * @param {object} [deps]  document
 * @returns {function} stop(), idempotent
 */
export function watchFramePolicy(onBlocked, deps = {}) {
  const doc = deps.document ?? globalDocument();
  const report = typeof onBlocked === 'function' ? onBlocked : null;
  let stopped = false;

  if (!doc || typeof doc.addEventListener !== 'function') {
    return () => {};
  }

  function handler(event) {
    if (stopped || !report) return;
    const directive = directiveOf(event);
    if (!concernsFrameSrc(directive)) return;
    try {
      report({
        blockedURI: event?.blockedURI ?? '',
        directive,
        event,
      });
    } catch {
      // A throwing reporter must not take the listener down with it.
    }
  }

  doc.addEventListener('securitypolicyviolation', handler);

  return function stop() {
    if (stopped) return;
    stopped = true;
    doc.removeEventListener('securitypolicyviolation', handler);
  };
}

function directiveOf(event) {
  const raw = event?.violatedDirective || event?.effectiveDirective || '';
  return String(raw).trim();
}

/**
 * Whether a violated directive is about frames.
 *
 * `violatedDirective` is historically the whole directive including its values
 * ("frame-src 'none'"), while `effectiveDirective` is the bare name, so only
 * the first token is compared. `child-src` and `default-src` are what a
 * browser falls back to when `frame-src` is absent, and a frame refused under
 * either is the same misconfiguration, so they count too.
 */
function concernsFrameSrc(directive) {
  const name = String(directive || '')
    .trim()
    .split(/\s+/)[0]
    .toLowerCase();
  return name === 'frame-src' || name === 'child-src' || name === 'default-src';
}

function isMountable(item) {
  return Boolean(
    item &&
      typeof item === 'object' &&
      toId(item.id) !== null &&
      typeof item.url === 'string' &&
      item.url.trim() !== '',
  );
}

function lookup(itemsById, id) {
  if (!itemsById) return null;
  if (typeof itemsById.get === 'function') return itemsById.get(id) ?? null;
  if (Object.prototype.hasOwnProperty.call(itemsById, id)) return itemsById[id] ?? null;
  return null;
}

function toId(id) {
  if (typeof id !== 'string') return null;
  const trimmed = id.trim();
  return trimmed === '' ? null : trimmed;
}

function joinTokens(value, separator) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return list
    .map((token) => String(token ?? '').trim())
    .filter((token) => token !== '')
    .join(separator);
}

function toMax(value, fallback) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return fallback;
  // Clamped to the same bound config.js enforces, so a caller that bypasses
  // config validation cannot ask for eighty frames.
  return Math.min(n, FRAME_MAX);
}

function toDelay(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function setDisplayNone(el) {
  // Through the CSSOM, never a style attribute in source: the page is served
  // under a strict CSP and the repo forbids inline style attributes. This is
  // belt and braces over the [data-active='false'] CSS rule, so that a missing
  // stylesheet shows one app instead of four stacked on top of each other.
  el.style?.setProperty?.('display', 'none');
}

function removeDisplayNone(el) {
  el.style?.removeProperty?.('display');
}

function ownerDocumentOf(el) {
  return el && typeof el === 'object' ? (el.ownerDocument ?? null) : null;
}

function globalDocument() {
  return typeof document === 'undefined' ? null : document;
}
