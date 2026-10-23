import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FRAME_DEFAULT_MAX,
  FRAME_MAX,
  FRAME_NUDGE_DELAY_MS,
  createFrameHost,
  watchFramePolicy,
} from '../src/assets/frames.js';
import * as configModule from '../src/assets/config.js';

// --- a DOM small enough to reason about ------------------------------------
//
// Only what frames.js touches, plus bookkeeping the assertions need: how many
// times `src` was written, whether the element was ever appended twice, and
// whether anything removed it.

function fakeElement(tag) {
  const attrs = new Map();
  const styles = new Map();
  const el = {
    tagName: tag.toUpperCase(),
    parent: null,
    children: [],
    srcWrites: 0,
    appendCount: 0,
    removeCount: 0,
    attrs,
    style: {
      setProperty(name, value) {
        styles.set(name, value);
      },
      removeProperty(name) {
        styles.delete(name);
      },
      get(name) {
        return styles.get(name);
      },
    },
    setAttribute(name, value) {
      if (name === 'src') el.srcWrites += 1;
      attrs.set(name, String(value));
    },
    getAttribute(name) {
      return attrs.has(name) ? attrs.get(name) : null;
    },
    hasAttribute(name) {
      return attrs.has(name);
    },
    removeAttribute(name) {
      attrs.delete(name);
    },
    appendChild(child) {
      if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
      child.parent = el;
      child.appendCount += 1;
      el.children.push(child);
      return child;
    },
    remove() {
      el.removeCount += 1;
      if (el.parent) {
        const index = el.parent.children.indexOf(el);
        if (index !== -1) el.parent.children.splice(index, 1);
      }
      el.parent = null;
    },
    get display() {
      return styles.get('display');
    },
  };
  // `src` as a property, because refresh() assigns it as well as setting the
  // attribute, and a real iframe navigates on that assignment.
  let src = '';
  Object.defineProperty(el, 'src', {
    get() {
      return src;
    },
    set(value) {
      src = String(value);
      el.srcWrites += 1;
    },
  });
  return el;
}

function fakeDocument() {
  const listeners = new Map();
  return {
    created: 0,
    createElement(tag) {
      this.created += 1;
      return fakeElement(tag);
    },
    get listenerCount() {
      let total = 0;
      for (const set of listeners.values()) total += set.size;
      return total;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatch(type, event) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn(event);
    },
  };
}

/** Fake timeouts: tick() fires everything due. */
function fakeTimers() {
  const live = new Map();
  let nextId = 1;
  return {
    get count() {
      return live.size;
    },
    setTimeout(fn, ms) {
      const id = nextId++;
      live.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      live.delete(id);
    },
    tick() {
      for (const [id, entry] of [...live.entries()]) {
        live.delete(id);
        entry.fn();
      }
    },
  };
}

/** A host under test, with a monotonic clock and recorded onChange calls. */
function setup({ maxFrames, nudgeDelayMs, confirm } = {}) {
  const doc = fakeDocument();
  const timers = fakeTimers();
  const hostEl = fakeElement('div');
  hostEl.setAttribute('hidden', '');
  const changes = [];
  let clock = 1000;
  const host = createFrameHost(hostEl, {
    maxFrames,
    nudgeDelayMs,
    onChange: (list) => changes.push(list),
    deps: {
      document: doc,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      confirm,
      now: () => (clock += 1),
    },
  });
  return { host, hostEl, doc, timers, changes, tick: () => timers.tick() };
}

function item(id, extra = {}) {
  return {
    id,
    name: `App ${id}`,
    url: `https://${id}.example.com/`,
    embed: true,
    ...extra,
  };
}

function frameFor(hostEl, id) {
  return hostEl.children.find((child) => child.getAttribute('data-frame-id') === id) ?? null;
}

// --- mounting ---------------------------------------------------------------

test('the default cap is four, and is the one config.js validates against', () => {
  assert.equal(FRAME_DEFAULT_MAX, 4);
  // One declaration, not two: a second copy of the default would drift.
  assert.equal(FRAME_DEFAULT_MAX, configModule.FRAME_DEFAULT_MAX);
  assert.equal(FRAME_MAX, configModule.FRAME_MAX);
  const { host } = setup();
  assert.equal(host.max, 4);
});

test('opening an item mounts one frame, focused, and reveals the host', () => {
  const { host, hostEl, changes } = setup();
  const result = host.open(item('a'));

  assert.deepEqual(result, { mounted: true, focused: true, evicted: null });
  assert.equal(hostEl.children.length, 1);
  assert.equal(hostEl.hasAttribute('hidden'), false);

  const frame = frameFor(hostEl, 'a');
  assert.equal(frame.tagName, 'IFRAME');
  assert.equal(frame.getAttribute('src'), 'https://a.example.com/');
  assert.equal(frame.getAttribute('data-active'), 'true');
  assert.equal(frame.getAttribute('title'), 'App a');
  assert.equal(frame.display, undefined);

  assert.equal(changes.length, 1);
  assert.equal(changes[0].length, 1);
  assert.equal(changes[0][0].focused, true);
  assert.equal(changes[0][0].item.url, 'https://a.example.com/');
});

test('referrerpolicy and loading are set deliberately', () => {
  const { host, hostEl } = setup();
  host.open(item('a'));
  const frame = frameFor(hostEl, 'a');
  assert.equal(frame.getAttribute('referrerpolicy'), 'no-referrer');
  assert.equal(frame.getAttribute('loading'), 'eager');
});

test('allow is set only when non-empty and sandbox only when asked for', () => {
  const { host, hostEl } = setup();

  host.open(item('plain'));
  host.open(item('empty', { allow: [], sandbox: [] }));
  host.open(item('asked', { allow: ['fullscreen', 'clipboard-write'], sandbox: ['allow-scripts'] }));

  for (const id of ['plain', 'empty']) {
    const frame = frameFor(hostEl, id);
    assert.equal(frame.hasAttribute('allow'), false, `${id} must have no allow`);
    // An empty sandbox attribute is maximally restrictive and would break the
    // app, so absence is the only acceptable result here.
    assert.equal(frame.hasAttribute('sandbox'), false, `${id} must have no sandbox`);
  }

  const asked = frameFor(hostEl, 'asked');
  assert.equal(asked.getAttribute('allow'), 'fullscreen; clipboard-write');
  assert.equal(asked.getAttribute('sandbox'), 'allow-scripts');
});

test('an item with no id or no url mounts nothing', () => {
  const { host, hostEl } = setup();
  for (const bad of [null, {}, { id: 'x' }, { id: '', url: 'https://example.com/' }, { url: 'u' }]) {
    assert.deepEqual(host.open(bad), { mounted: false, focused: false, evicted: null });
  }
  assert.equal(hostEl.children.length, 0);
  assert.equal(host.count(), 0);
});

// --- the rule that matters: nothing reloads, nothing moves ------------------

test('every operation except close leaves the element identical and src written once', () => {
  const { host, hostEl, tick } = setup({ maxFrames: 3 });

  host.open(item('a'));
  const frame = frameFor(hostEl, 'a');
  const writesAfterMount = frame.srcWrites;
  assert.equal(writesAfterMount, 1);

  // Everything the host supports, short of closing it.
  host.open(item('b'));
  host.open(item('c'));
  host.focus('a');
  host.focus('b');
  host.focus('a');
  host.open(item('a')); // re-activating an already open item
  host.open(item('a', { name: 'Renamed' })); // a config reload renaming it
  host.setMax(2);
  host.setMax(9);
  host.list();
  host.has('a');
  host.count();
  host.restore(['a', 'zz'], { a: item('a') }); // already mounted + unknown
  host.pruneMissing({ a: item('a'), b: item('b'), c: item('c') });
  host.dismissNudge('a');
  tick(); // let the nudge timers fire
  host.dismissNudge('a');
  host.refresh('nosuch');
  host.close('nosuch');

  const same = frameFor(hostEl, 'a');
  assert.equal(same, frame, 'the frame element must be the very same node');
  assert.equal(frame.appendCount, 1, 'appended exactly once, ever');
  assert.equal(frame.removeCount, 0, 'never removed');
  assert.equal(frame.srcWrites, writesAfterMount, 'src must never be reassigned');
  assert.equal(frame.getAttribute('src'), 'https://a.example.com/');
  assert.equal(frame.parent, hostEl);
});

test('switching tabs changes visibility only, and never the DOM position', () => {
  const { host, hostEl } = setup();
  host.open(item('a'));
  host.open(item('b'));

  const order = hostEl.children.map((child) => child.getAttribute('data-frame-id'));
  const a = frameFor(hostEl, 'a');
  const b = frameFor(hostEl, 'b');

  assert.equal(a.getAttribute('data-active'), 'false');
  assert.equal(a.display, 'none');
  assert.equal(a.getAttribute('aria-hidden'), 'true');
  assert.equal(a.hasAttribute('inert'), true);
  assert.equal(b.getAttribute('data-active'), 'true');
  assert.equal(b.display, undefined);

  host.focus('a');

  assert.deepEqual(
    hostEl.children.map((child) => child.getAttribute('data-frame-id')),
    order,
    'nothing may be reordered',
  );
  assert.equal(a.getAttribute('data-active'), 'true');
  assert.equal(a.display, undefined);
  assert.equal(a.hasAttribute('aria-hidden'), false);
  assert.equal(a.hasAttribute('inert'), false);
  assert.equal(b.display, 'none');
  assert.equal(a.srcWrites, 1);
  assert.equal(b.srcWrites, 1);
});

test('a hidden frame stays in the DOM with a src, and the host keeps no hidden attribute', () => {
  const { host, hostEl } = setup();
  host.open(item('a'));
  host.open(item('b'));
  const a = frameFor(hostEl, 'a');

  assert.equal(a.parent, hostEl, 'hiding must not unmount');
  assert.equal(a.getAttribute('src'), 'https://a.example.com/');
  assert.notEqual(a.getAttribute('src'), '');
  assert.equal(
    hostEl.hasAttribute('hidden'),
    false,
    'hidden on the shared host would unload every frame at once',
  );
});

test('opening an already open item focuses it and evicts nothing', () => {
  const { host, hostEl } = setup({ maxFrames: 2 });
  host.open(item('a'));
  host.open(item('b'));
  const a = frameFor(hostEl, 'a');

  const result = host.open(item('a'));

  assert.deepEqual(result, { mounted: false, focused: true, evicted: null });
  assert.equal(host.count(), 2);
  assert.equal(a.srcWrites, 1);
  assert.equal(host.focusedId(), 'a');
});

// --- refresh ---------------------------------------------------------------

test('refresh is the only thing that reassigns src, and refreshes one frame', () => {
  const { host, hostEl } = setup();
  host.open(item('a'));
  host.open(item('b'));
  const a = frameFor(hostEl, 'a');
  const b = frameFor(hostEl, 'b');

  assert.equal(host.refresh('a'), true);

  assert.equal(a.srcWrites > 1, true, 'refresh must navigate');
  assert.equal(a.getAttribute('src'), 'https://a.example.com/');
  assert.equal(b.srcWrites, 1, 'only the named frame reloads');
  assert.equal(a.appendCount, 1, 'refresh must not re-append');
  assert.equal(host.count(), 2, 'refresh closes nothing');
});

test('refreshAll reloads every frame and closes none', () => {
  const { host, hostEl } = setup();
  host.open(item('a'));
  host.open(item('b'));
  const before = ['a', 'b'].map((id) => frameFor(hostEl, id));

  assert.equal(host.refreshAll(), 2);

  assert.equal(host.count(), 2);
  for (const frame of before) {
    assert.equal(frame.srcWrites > 1, true);
    assert.equal(frame.appendCount, 1);
    assert.equal(frame.removeCount, 0);
  }
  assert.deepEqual(
    ['a', 'b'].map((id) => frameFor(hostEl, id)),
    before,
    'same nodes after a refresh',
  );
});

// --- the cap and eviction --------------------------------------------------

test('within the cap, opening another leaves the others alone', () => {
  const { host, hostEl } = setup({ maxFrames: 4 });
  host.open(item('a'));
  const a = frameFor(hostEl, 'a');
  host.open(item('b'));
  host.open(item('c'));

  assert.equal(host.count(), 3);
  assert.equal(frameFor(hostEl, 'a'), a);
  assert.equal(a.srcWrites, 1);
});

test('eviction takes the least recently focused, not the least recently opened', () => {
  const { host, hostEl } = setup({ maxFrames: 3 });
  host.open(item('a'));
  host.open(item('b'));
  host.open(item('c'));

  // Touch a and c, leaving b as the least recently focused although it was
  // opened second.
  host.focus('a');
  host.focus('c');
  host.focus('a');

  const result = host.open(item('d'));

  assert.equal(result.mounted, true);
  assert.deepEqual(
    result.evicted && { id: result.evicted.id, name: result.evicted.item.name },
    { id: 'b', name: 'App b' },
    'the return value must name what was closed, so the UI can say so',
  );
  assert.equal(host.has('b'), false);
  assert.equal(frameFor(hostEl, 'b'), null);
  assert.deepEqual(
    host.list().map((entry) => entry.id),
    ['a', 'c', 'd'],
  );
});

test('the focused frame is never the eviction victim', () => {
  const { host } = setup({ maxFrames: 2 });
  host.open(item('a'));
  host.open(item('b')); // b is focused, a is least recently focused
  const result = host.open(item('c'));
  assert.equal(result.evicted.id, 'a');
  assert.equal(host.focusedId(), 'c');
});

test('with a cap of one, opening replaces the single frame', () => {
  const { host } = setup({ maxFrames: 1 });
  host.open(item('a'));
  const result = host.open(item('b'));
  assert.equal(result.evicted.id, 'a');
  assert.equal(host.count(), 1);
  assert.equal(host.focusedId(), 'b');
});

test('setMax lowering the cap closes nothing and drains one per open', () => {
  const { host } = setup({ maxFrames: 4 });
  for (const id of ['a', 'b', 'c', 'd']) host.open(item(id));

  assert.equal(host.setMax(2), 2);
  assert.equal(host.count(), 4, 'lowering the cap must not evict anything');
  assert.equal(host.has('a'), true);

  // Each later open evicts exactly one, so the count walks down to the cap
  // instead of several apps vanishing at once.
  const first = host.open(item('e'));
  assert.equal(first.evicted.id, 'a');
  assert.equal(host.count(), 4);
  const second = host.open(item('f'));
  assert.equal(second.evicted.id, 'b');
  assert.equal(host.count(), 4);

  assert.equal(host.setMax(0), 2, 'a nonsense cap is ignored');
  assert.equal(host.setMax(Number.NaN), 2);
  assert.equal(host.setMax(500), FRAME_MAX, 'raising is clamped to the sanity bound');
});

test('the count and the cap are both readable for the strip', () => {
  const { host } = setup({ maxFrames: 3 });
  host.open(item('a'));
  assert.equal(host.count(), 1);
  assert.equal(host.max, 3);
});

// --- close -----------------------------------------------------------------

test('closing returns what it closed and refocuses a survivor', () => {
  const { host, hostEl } = setup();
  host.open(item('a'));
  host.open(item('b'));
  host.focus('a');

  const closed = host.close('a');

  assert.equal(closed.id, 'a');
  assert.equal(frameFor(hostEl, 'a'), null);
  assert.equal(host.focusedId(), 'b');
  assert.equal(frameFor(hostEl, 'b').getAttribute('data-active'), 'true');
  assert.equal(host.close('a'), null, 'closing twice is harmless');
});

test('closing the last frame hides the empty host again', () => {
  const { host, hostEl } = setup();
  host.open(item('a'));
  host.close('a');
  assert.equal(hostEl.children.length, 0);
  assert.equal(hostEl.hasAttribute('hidden'), true);
});

test('closeAll with more than one open asks first when given a confirm', () => {
  const asked = [];
  const { host } = setup({
    confirm: (message) => {
      asked.push(message);
      return false;
    },
  });
  host.open(item('a'));
  host.open(item('b'));

  const declined = host.closeAll();

  assert.deepEqual(declined, { closed: [], confirmed: false });
  assert.equal(host.count(), 2, 'a declined close must change nothing');
  assert.equal(asked.length, 1);
  assert.match(asked[0], /2 open apps/);

  const accepted = host.closeAll({ confirm: () => true });
  assert.equal(accepted.confirmed, true);
  assert.deepEqual(
    accepted.closed.map((entry) => entry.id),
    ['a', 'b'],
  );
  assert.equal(host.count(), 0);
});

test('closeAll with one frame does not ask', () => {
  let asks = 0;
  const { host } = setup({
    confirm: () => {
      asks += 1;
      return true;
    },
  });
  host.open(item('a'));
  assert.equal(host.closeAll().closed.length, 1);
  assert.equal(asks, 0);
});

// --- restore ---------------------------------------------------------------

test('restore mounts a remembered set from scratch and skips unknown ids', () => {
  const { host, hostEl, changes } = setup();
  const itemsById = { a: item('a'), c: item('c') };

  const result = host.restore(['a', 'gone', 'c'], itemsById);

  assert.deepEqual(result, { mounted: ['a', 'c'], skipped: ['gone'] });
  assert.equal(host.count(), 2);
  assert.deepEqual(
    host.list().map((entry) => entry.id),
    ['a', 'c'],
    'strip order follows the remembered order',
  );
  assert.equal(host.focusedId(), 'a');
  assert.equal(frameFor(hostEl, 'a').srcWrites, 1, 'a fresh mount, not a reload');
  assert.equal(changes.length, 1, 'one change for the whole restore');
});

test('restore accepts a Map, tolerates junk, and respects the cap', () => {
  const { host } = setup({ maxFrames: 2 });
  const itemsById = new Map([
    ['a', item('a')],
    ['b', item('b')],
    ['c', item('c')],
    ['off', item('off', { embed: false })],
  ]);

  const result = host.restore(['a', 'a', '', null, 'off', 'b', 'c'], itemsById);

  assert.deepEqual(result.mounted, ['a', 'b']);
  assert.deepEqual(result.skipped, ['a', 'off', 'c']);
  assert.equal(host.count(), 2, 'restore never evicts to make room');
  assert.deepEqual(host.restore(null, itemsById), { mounted: [], skipped: [] });
});

test('restore works on the Map that config.js indexItems returns', () => {
  const parsed = configModule.normalizeConfig({
    version: 1,
    groups: [
      {
        name: 'Group',
        items: [
          { name: 'One', url: 'https://one.example.com/', embed: true },
          { name: 'Two', url: 'https://two.example.com/', embed: true, allow: ['fullscreen'] },
        ],
      },
    ],
  });
  const itemsById = configModule.indexItems(parsed.config ?? parsed);
  const ids = [...itemsById.keys()];
  assert.equal(ids.length, 2);

  const { host, hostEl } = setup();
  const result = host.restore([...ids, 'not-in-config'], itemsById);

  assert.deepEqual(result.mounted, ids);
  assert.deepEqual(result.skipped, ['not-in-config']);
  const frame = frameFor(hostEl, ids[1]);
  assert.equal(frame.getAttribute('allow'), 'fullscreen');
  assert.equal(frame.getAttribute('src'), 'https://two.example.com/');
});

test('pruneMissing closes tabs whose items left the config', () => {
  const { host, hostEl } = setup();
  host.open(item('a'));
  host.open(item('b'));
  const a = frameFor(hostEl, 'a');

  const closed = host.pruneMissing({ a: item('a') });

  assert.deepEqual(
    closed.map((entry) => entry.id),
    ['b'],
  );
  assert.equal(host.has('a'), true);
  assert.equal(frameFor(hostEl, 'a'), a, 'the surviving frame is untouched');
  assert.equal(a.srcWrites, 1);
  assert.deepEqual(host.pruneMissing({ a: item('a') }), []);
});

// --- the "nothing has appeared" nudge --------------------------------------

test('a frame that has shown nothing is marked nudged, and the mark is dismissible', () => {
  const { host, changes, tick } = setup();
  host.open(item('a'));
  assert.equal(host.list()[0].nudged, false);

  tick();

  assert.equal(host.list()[0].nudged, true);
  assert.equal(changes.at(-1)[0].nudged, true, 'the view hears about it through onChange');

  assert.equal(host.dismissNudge('a'), true);
  assert.equal(host.list()[0].nudged, false);
  assert.equal(host.dismissNudge('a'), false, 'dismissing twice is harmless');
});

test('the nudge timer can be switched off, and refresh re-arms it', () => {
  const quiet = setup({ nudgeDelayMs: 0 });
  quiet.host.open(item('a'));
  quiet.tick();
  assert.equal(quiet.host.list()[0].nudged, false);
  assert.equal(quiet.timers.count, 0);
  assert.equal(FRAME_NUDGE_DELAY_MS > 0, true);

  const live = setup();
  live.host.open(item('a'));
  live.tick();
  assert.equal(live.host.list()[0].nudged, true);
  live.host.refresh('a');
  assert.equal(live.host.list()[0].nudged, false, 'a reload starts the clock again');
  assert.equal(live.timers.count, 1);
});

test('closing a frame cancels its pending nudge timer', () => {
  const { host, timers } = setup();
  host.open(item('a'));
  assert.equal(timers.count, 1);
  host.close('a');
  assert.equal(timers.count, 0);
});

// --- destroy ---------------------------------------------------------------

test('destroy removes every frame and timer, and is idempotent', () => {
  const { host, hostEl, timers, changes } = setup();
  host.open(item('a'));
  host.open(item('b'));
  assert.equal(timers.count, 2);

  host.destroy();

  assert.equal(hostEl.children.length, 0);
  assert.equal(host.count(), 0);
  assert.equal(timers.count, 0, 'no timer may outlive the host');
  assert.equal(hostEl.hasAttribute('hidden'), true);

  const after = changes.length;
  host.destroy();
  assert.equal(changes.length, after, 'a second destroy does nothing');
  assert.equal(timers.count, 0);
});

test('a destroyed host accepts no further work', () => {
  const { host, hostEl } = setup();
  host.destroy();

  assert.deepEqual(host.open(item('a')), { mounted: false, focused: false, evicted: null });
  assert.equal(host.focus('a'), false);
  assert.equal(host.close('a'), null);
  assert.equal(host.refresh('a'), false);
  assert.equal(host.refreshAll(), 0);
  assert.deepEqual(host.restore(['a'], { a: item('a') }), { mounted: [], skipped: [] });
  assert.deepEqual(host.pruneMissing({}), []);
  assert.deepEqual(host.closeAll(), { closed: [], confirmed: true });
  assert.equal(hostEl.children.length, 0);
});

test('a throwing onChange does not break the host', () => {
  const doc = fakeDocument();
  const timers = fakeTimers();
  const hostEl = fakeElement('div');
  const host = createFrameHost(hostEl, {
    onChange: () => {
      throw new Error('the view is broken');
    },
    deps: { document: doc, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
  });

  assert.equal(host.open(item('a')).mounted, true);
  assert.equal(host.count(), 1);
  assert.equal(hostEl.children.length, 1);
});

test('the host works with no onChange at all', () => {
  const doc = fakeDocument();
  const hostEl = fakeElement('div');
  const host = createFrameHost(hostEl, { deps: { document: doc } });
  assert.equal(host.open(item('a')).mounted, true);
  host.destroy();
});

// --- CSP watching ----------------------------------------------------------

test('watchFramePolicy reports only frame-related violations', () => {
  const doc = fakeDocument();
  const seen = [];
  const stop = watchFramePolicy((report) => seen.push(report), { document: doc });

  doc.dispatch('securitypolicyviolation', {
    violatedDirective: "frame-src 'none'",
    blockedURI: 'https://app.example.com/',
  });
  doc.dispatch('securitypolicyviolation', {
    effectiveDirective: 'frame-src',
    blockedURI: 'https://other.example.org/',
  });
  doc.dispatch('securitypolicyviolation', {
    violatedDirective: "script-src 'self'",
    blockedURI: 'inline',
  });
  doc.dispatch('securitypolicyviolation', {
    violatedDirective: "img-src 'self'",
    blockedURI: 'https://img.example.com/x.png',
  });
  doc.dispatch('securitypolicyviolation', {});

  assert.deepEqual(
    seen.map((report) => report.blockedURI),
    ['https://app.example.com/', 'https://other.example.org/'],
  );
  assert.equal(seen[0].directive, "frame-src 'none'");
  stop();
});

test('child-src and default-src count, because frames fall back to them', () => {
  const doc = fakeDocument();
  const seen = [];
  const stop = watchFramePolicy((report) => seen.push(report.directive), { document: doc });
  doc.dispatch('securitypolicyviolation', { effectiveDirective: 'child-src', blockedURI: 'x' });
  doc.dispatch('securitypolicyviolation', { effectiveDirective: 'default-src', blockedURI: 'y' });
  assert.deepEqual(seen, ['child-src', 'default-src']);
  stop();
});

test('stop() removes the listener and is idempotent', () => {
  const doc = fakeDocument();
  const seen = [];
  assert.equal(doc.listenerCount, 0);

  const stop = watchFramePolicy((report) => seen.push(report), { document: doc });
  assert.equal(doc.listenerCount, 1);

  stop();
  assert.equal(doc.listenerCount, 0, 'every listener it added must be removed');
  stop();
  assert.equal(doc.listenerCount, 0);

  doc.dispatch('securitypolicyviolation', {
    effectiveDirective: 'frame-src',
    blockedURI: 'https://app.example.com/',
  });
  assert.equal(seen.length, 0, 'nothing may be reported after stop');
});

test('watchFramePolicy survives a missing document and a throwing reporter', () => {
  const stopNoDoc = watchFramePolicy(() => {}, { document: null });
  assert.equal(typeof stopNoDoc, 'function');
  stopNoDoc();

  const doc = fakeDocument();
  const stop = watchFramePolicy(() => {
    throw new Error('the notice is broken');
  }, { document: doc });
  doc.dispatch('securitypolicyviolation', { effectiveDirective: 'frame-src', blockedURI: 'x' });
  stop();
  assert.equal(doc.listenerCount, 0);
});

test('nothing in the module claims the target refused framing', async () => {
  // The unknowable thing must stay unknowable: no X-Frame-Options sniffing, no
  // load/timing heuristic dressed up as a diagnosis, no "blocked by target"
  // flag for a caller to render.
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/assets/frames.js', import.meta.url), 'utf8');
  // Prose about what we deliberately do not do is fine; code is not. Strip
  // both comment forms before looking.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');

  for (const forbidden of ['X-Frame-Options', 'x-frame-options', 'frame-ancestors', 'contentDocument', 'refused']) {
    assert.equal(code.includes(forbidden), false, `frames.js must not mention ${forbidden}`);
  }
  for (const key of ['blockedByTarget', 'framingBlocked', 'refusedFraming']) {
    assert.equal(source.includes(key), false, `no ${key} signal may exist`);
  }
});

// --- the DOM contract ------------------------------------------------------

test('a re-render of a sibling subtree cannot touch a mounted frame', () => {
  // Stands in for render.js rewriting #portal: the frame host is a sibling, so
  // whatever happens in there, the frame element and its src are untouched.
  const doc = fakeDocument();
  const body = fakeElement('div');
  const portal = fakeElement('main');
  const hostEl = fakeElement('div');
  body.appendChild(portal);
  body.appendChild(hostEl);

  const host = createFrameHost(hostEl, { deps: { document: doc } });
  host.open(item('a'));
  const frame = frameFor(hostEl, 'a');

  // The "re-render": every child of #portal replaced.
  for (const child of [...portal.children]) child.remove();
  portal.appendChild(doc.createElement('section'));
  portal.appendChild(doc.createElement('section'));

  assert.equal(frameFor(hostEl, 'a'), frame);
  assert.equal(frame.parent, hostEl);
  assert.equal(frame.srcWrites, 1);
  assert.equal(frame.appendCount, 1);
  assert.equal(frame.removeCount, 0);
});

test('index.html keeps the frame host and strip outside the re-rendered main', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
  const strip = html.indexOf('id="tab-strip"');
  const frameHost = html.indexOf('id="frame-host"');
  const main = html.indexOf('<main id="portal"');
  const mainEnd = html.indexOf('</main>');

  assert.equal(strip > -1 && frameHost > -1 && main > -1, true);
  assert.equal(frameHost < main || frameHost > mainEnd, true, '#frame-host must not be in <main>');
  assert.equal(strip < main || strip > mainEnd, true, '#tab-strip must not be in <main>');
});

test('the module imports and runs with no DOM-shaped globals', () => {
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(typeof createFrameHost, 'function');
  assert.equal(typeof watchFramePolicy, 'function');
  const stop = watchFramePolicy(() => {});
  stop();
});
