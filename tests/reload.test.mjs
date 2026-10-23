import test from 'node:test';
import assert from 'node:assert/strict';

import { watchConfig, hashBody } from '../src/assets/reload.js';

const CONFIG_URL = './config/config.yaml';

/** Let the pending fetch/text promise chain settle. */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A Response-like object. `text` throws if the test said the body is off limits. */
function response({ status = 200, etag = null, body = '', parseable = true } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => (name.toLowerCase() === 'etag' ? etag : null) },
    text: async () => {
      if (!parseable) throw new Error('body must not be read');
      return body;
    },
  };
}

/** Fake interval timers: tick() runs every registered callback once. */
function fakeTimers() {
  const live = new Map();
  let nextId = 1;
  return {
    get count() {
      return live.size;
    },
    setInterval(fn, ms) {
      const id = nextId++;
      live.set(id, { fn, ms });
      return id;
    },
    clearInterval(id) {
      live.delete(id);
    },
    tick() {
      for (const entry of [...live.values()]) entry.fn();
    },
  };
}

/** Fake document with a controllable `hidden` and real listener bookkeeping. */
function fakeDocument(hidden = false) {
  const listeners = new Map();
  return {
    hidden,
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
    dispatch(type) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn();
    },
  };
}

/** Records requests and replays a queue of responses. */
function fetchStub(queue) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, headers: { ...(init?.headers ?? {}) } });
    const next = queue.shift();
    if (!next) throw new Error('no queued response');
    if (next instanceof Error) throw next;
    return next;
  };
  return { requests, fetch: fetchImpl };
}

test('hashBody is stable and distinguishes different bodies', () => {
  assert.equal(hashBody('version: 1\n'), hashBody('version: 1\n'));
  assert.notEqual(hashBody('version: 1\n'), hashBody('version: 1\ntitle: Home\n'));
  assert.equal(typeof hashBody(''), 'string');
});

test('a changed body signals a change once per poll', async () => {
  const timers = fakeTimers();
  const { requests, fetch } = fetchStub([
    response({ etag: 'W/"1"', body: 'version: 1\n' }),
    response({ etag: 'W/"2"', body: 'version: 1\ntitle: Home\n' }),
  ]);
  const seen = [];

  const stop = watchConfig(CONFIG_URL, 30, (text) => seen.push(text), {
    fetch,
    document: fakeDocument(),
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });

  timers.tick();
  await flush();
  assert.equal(seen.length, 1, 'the first body seen is a change against no baseline');
  assert.equal(requests[0].headers['If-None-Match'], undefined, 'nothing to revalidate yet');

  timers.tick();
  await flush();
  assert.deepEqual(seen, ['version: 1\n', 'version: 1\ntitle: Home\n']);
  assert.equal(requests[1].headers['If-None-Match'], 'W/"1"', 'the last ETag is revalidated');

  stop();
});

test('a 304 parses nothing and signals nothing', async () => {
  const timers = fakeTimers();
  const { requests, fetch } = fetchStub([
    response({ status: 304, parseable: false }),
    response({ status: 304, parseable: false }),
  ]);
  let changes = 0;

  const stop = watchConfig(CONFIG_URL, 30, () => (changes += 1), {
    fetch,
    document: fakeDocument(),
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    etag: 'W/"1"',
    body: 'version: 1\n',
  });

  timers.tick();
  await flush();
  timers.tick();
  await flush();

  assert.equal(changes, 0);
  assert.equal(requests[0].headers['If-None-Match'], 'W/"1"');
  assert.equal(requests[1].headers['If-None-Match'], 'W/"1"', 'the ETag survives a 304');

  stop();
});

test('a new ETag over byte-identical content is not a change', async () => {
  const timers = fakeTimers();
  const body = 'version: 1\ntitle: Home\n';
  const { fetch } = fetchStub([
    response({ etag: 'W/"abc"', body }),
    response({ etag: 'W/"def"', body }),
  ]);
  let changes = 0;

  const stop = watchConfig(CONFIG_URL, 30, () => (changes += 1), {
    fetch,
    document: fakeDocument(),
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    etag: 'W/"old"',
    body,
  });

  timers.tick();
  await flush();
  timers.tick();
  await flush();

  assert.equal(changes, 0, 'the content hash matched both times');
  stop();
});

test('polling pauses while hidden and fires exactly one poll on becoming visible', async () => {
  const timers = fakeTimers();
  const doc = fakeDocument(true);
  const { requests, fetch } = fetchStub([
    response({ etag: 'W/"2"', body: 'version: 1\ntitle: Later\n' }),
    response({ etag: 'W/"2"', body: 'version: 1\ntitle: Later\n' }),
  ]);
  let changes = 0;

  const stop = watchConfig(CONFIG_URL, 30, () => (changes += 1), {
    fetch,
    document: doc,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    etag: 'W/"1"',
    body: 'version: 1\n',
  });

  assert.equal(timers.count, 0, 'no timer is armed while the page is hidden');

  // An hour of being hidden: the tick source exists, but nothing is registered.
  timers.tick();
  await flush();
  assert.equal(requests.length, 0, 'no polls while hidden');

  doc.hidden = false;
  doc.dispatch('visibilitychange');
  await flush();

  assert.equal(requests.length, 1, 'exactly one poll on becoming visible, not a backlog');
  assert.equal(changes, 1);
  assert.equal(timers.count, 1, 'the interval resumes');

  doc.hidden = true;
  doc.dispatch('visibilitychange');
  assert.equal(timers.count, 0, 'and pauses again');

  stop();
});

test('a failed fetch does not kill the watcher and does not signal a change', async () => {
  const timers = fakeTimers();
  const { fetch } = fetchStub([
    new Error('network down'),
    response({ status: 500, parseable: false }),
    response({ etag: 'W/"2"', body: 'version: 1\ntitle: Back\n' }),
  ]);
  const seen = [];
  const errors = [];

  const stop = watchConfig(CONFIG_URL, 30, (text) => seen.push(text), {
    fetch,
    document: fakeDocument(),
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    onError: (error) => errors.push(error),
    etag: 'W/"1"',
    body: 'version: 1\n',
  });

  timers.tick();
  await flush();
  timers.tick();
  await flush();
  assert.deepEqual(seen, [], 'no onChange for a failure');
  assert.equal(errors.length, 2);

  timers.tick();
  await flush();
  assert.deepEqual(seen, ['version: 1\ntitle: Back\n'], 'the next tick recovers');

  stop();
});

test('an interval of 0 disables polling but keeps stop and a manual refetch working', async () => {
  const timers = fakeTimers();
  const doc = fakeDocument();
  const { requests, fetch } = fetchStub([response({ etag: 'W/"1"', body: 'version: 1\n' })]);
  const seen = [];

  const stop = watchConfig(CONFIG_URL, 0, (text) => seen.push(text), {
    fetch,
    document: doc,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });

  assert.equal(timers.count, 0);
  assert.equal(doc.listenerCount, 0, 'nothing to listen for with polling off');

  timers.tick();
  await flush();
  assert.equal(requests.length, 0);

  await stop.refresh();
  assert.equal(requests.length, 1, 'the manual refetch bypasses the interval');
  assert.deepEqual(seen, ['version: 1\n']);

  stop();
  stop();
});

test('a forced manual refresh skips revalidation and signals unchanged content', async () => {
  const body = 'version: 1\n';
  const { requests, fetch } = fetchStub([response({ etag: 'W/"1"', body })]);
  const seen = [];

  const stop = watchConfig(CONFIG_URL, 0, (text) => seen.push(text), {
    fetch,
    document: fakeDocument(),
    etag: 'W/"1"',
    body,
  });

  await stop.refresh({ force: true });

  assert.equal(requests[0].headers['If-None-Match'], undefined);
  assert.deepEqual(seen, [body], 'a deliberate reload always re-renders');
  stop();
});

test('stop is idempotent and removes every timer and listener it added', async () => {
  const timers = fakeTimers();
  const doc = fakeDocument();
  const { requests, fetch } = fetchStub([response({ etag: 'W/"1"', body: 'version: 1\n' })]);

  const stop = watchConfig(CONFIG_URL, 30, () => {}, {
    fetch,
    document: doc,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });

  assert.equal(timers.count, 1);
  assert.equal(doc.listenerCount, 1);

  stop();
  stop();

  assert.equal(timers.count, 0);
  assert.equal(doc.listenerCount, 0);

  doc.dispatch('visibilitychange');
  await stop.refresh();
  await flush();
  assert.equal(requests.length, 0, 'a stopped watcher issues no further requests');
});

test('overlapping polls are collapsed into one in-flight request', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push(init);
    await gate;
    return response({ etag: 'W/"1"', body: 'version: 1\n' });
  };

  const stop = watchConfig(CONFIG_URL, 0, () => {}, { fetch: fetchImpl, document: fakeDocument() });

  const first = stop.refresh();
  const second = stop.refresh();
  release();
  await Promise.all([first, second]);

  assert.equal(requests.length, 1);
  stop();
});

test('the module imports and runs with no DOM and no global fetch', async () => {
  const { requests, fetch } = fetchStub([response({ etag: 'W/"1"', body: 'version: 1\n' })]);
  const stop = watchConfig(CONFIG_URL, 0, () => {}, { fetch });

  await stop.refresh();
  assert.equal(requests.length, 1);
  stop();
});
