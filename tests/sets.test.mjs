import test from 'node:test';
import assert from 'node:assert/strict';

import { openSet, resolveTargets, SET_CONFIRM_THRESHOLD } from '../src/assets/sets.js';

// A config shaped like normalizeConfig's output: nested groups, items with ids.
const config = {
  version: 1,
  groups: [
    {
      id: 'media',
      name: 'Media',
      items: [
        { id: 'library', name: 'Library', url: 'https://library.example.com' },
        { id: 'requests', name: 'Requests', url: 'https://requests.example.com' },
      ],
      groups: [
        {
          id: 'media-admin',
          name: 'Admin',
          items: [{ id: 'indexer', name: 'Indexer', url: 'https://indexer.example.com' }],
          groups: [],
        },
      ],
    },
    {
      id: 'ops',
      name: 'Ops',
      items: [{ id: 'dashboards', name: 'Dashboards', url: 'https://dashboards.example.org' }],
      groups: [],
    },
  ],
  sets: [],
};

/** Records every open call; `handles` decides which ones the browser allows. */
function openRecorder(blockedUrls = []) {
  const calls = [];
  const open = (url, target) => {
    calls.push({ url, target });
    return blockedUrls.includes(url) ? null : { url };
  };
  return { calls, open };
}

test('a set of three resolvable targets opens three tabs', () => {
  const { calls, open } = openRecorder();
  const set = { id: 'morning', name: 'Morning check', targets: ['library', 'dashboards', 'indexer'] };

  const result = openSet(set, config, { open });

  assert.equal(result.opened, 3);
  assert.deepEqual(result.blocked, []);
  assert.deepEqual(
    calls.map((c) => c.url),
    ['https://library.example.com', 'https://dashboards.example.org', 'https://indexer.example.com'],
  );
});

test('a group id opens every item beneath it, depth-first in config order', () => {
  const { calls, open } = openRecorder();

  const result = openSet({ id: 'all-media', name: 'All media', targets: ['media'] }, config, { open });

  assert.equal(result.opened, 3);
  assert.deepEqual(
    calls.map((c) => c.url),
    [
      'https://library.example.com',
      'https://requests.example.com',
      'https://indexer.example.com',
    ],
  );
});

test('a bare URL target opens as given', () => {
  const { calls, open } = openRecorder();

  const result = openSet({ id: 's', name: 'S', targets: ['https://status.example.com'] }, config, { open });

  assert.equal(result.opened, 1);
  assert.equal(calls[0].url, 'https://status.example.com');
});

test('items opt into a target, defaulting to _blank', () => {
  const { calls, open } = openRecorder();
  const local = {
    version: 1,
    groups: [
      {
        id: 'g',
        name: 'G',
        items: [{ id: 'here', name: 'Here', url: 'https://here.example.com', target: '_self' }],
        groups: [],
      },
    ],
  };

  openSet({ id: 's', name: 'S', targets: ['here', 'https://there.example.com'] }, local, { open });

  assert.deepEqual(
    calls.map((c) => c.target),
    ['_self', '_blank'],
  );
});

test('blocked targets are reported, not thrown and not retried', () => {
  const { calls, open } = openRecorder(['https://requests.example.com']);

  const result = openSet({ id: 'm', name: 'M', targets: ['media'] }, config, { open });

  assert.equal(result.opened, 2);
  assert.deepEqual(
    result.blocked.map((item) => item.url),
    ['https://requests.example.com'],
  );
  assert.equal(result.blocked[0].name, 'Requests', 'blocked entries carry enough to render a link');
  assert.equal(calls.length, 3, 'each target is attempted exactly once');
});

test('when every target is blocked, nothing opened and all are reported', () => {
  const urls = [
    'https://library.example.com',
    'https://requests.example.com',
    'https://indexer.example.com',
  ];
  const { open } = openRecorder(urls);

  const result = openSet({ id: 'm', name: 'M', targets: ['media'] }, config, { open });

  assert.equal(result.opened, 0);
  assert.deepEqual(result.blocked.map((i) => i.url), urls);
});

function bigSet(count) {
  const items = [];
  for (let i = 0; i < count; i += 1) {
    items.push({ id: `i${i}`, name: `Item ${i}`, url: `https://n${i}.example.com` });
  }
  const local = { version: 1, groups: [{ id: 'big', name: 'Big', items, groups: [] }] };
  return { local, set: { id: 'big-set', name: 'Everything', targets: ['big'] } };
}

test('a set above the threshold confirms first and opens nothing when declined', () => {
  const { local, set } = bigSet(SET_CONFIRM_THRESHOLD + 1);
  const { calls, open } = openRecorder();
  const prompts = [];

  const result = openSet(set, local, {
    open,
    confirm: (message) => {
      prompts.push(message);
      return false;
    },
  });

  assert.equal(calls.length, 0, 'nothing opens before confirmation');
  assert.equal(result.opened, 0);
  assert.deepEqual(result.blocked, []);
  assert.equal(result.confirmed, false);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], new RegExp(String(SET_CONFIRM_THRESHOLD + 1)), 'the prompt states the count');
});

test('a confirmed oversized set opens everything', () => {
  const { local, set } = bigSet(SET_CONFIRM_THRESHOLD + 1);
  const { calls, open } = openRecorder();

  const result = openSet(set, local, { open, confirm: () => true });

  assert.equal(result.opened, SET_CONFIRM_THRESHOLD + 1);
  assert.equal(calls.length, SET_CONFIRM_THRESHOLD + 1);
});

test('a set at exactly the threshold does not confirm', () => {
  const { local, set } = bigSet(SET_CONFIRM_THRESHOLD);
  const { open } = openRecorder();
  let asked = false;

  const result = openSet(set, local, {
    open,
    confirm: () => {
      asked = true;
      return false;
    },
  });

  assert.equal(asked, false);
  assert.equal(result.opened, SET_CONFIRM_THRESHOLD);
});

test('every open happens synchronously in one call stack', () => {
  const events = [];
  const open = (url) => {
    events.push(url);
    return { url };
  };

  // A microtask queued before the call can only run once the synchronous stack
  // has unwound. If openSet ever awaited between opens, "microtask" would land
  // in the middle of the urls and the browser would block the rest.
  Promise.resolve().then(() => events.push('microtask'));

  const result = openSet({ id: 'm', name: 'M', targets: ['media'] }, config, { open });

  assert.equal(typeof result.then, 'undefined', 'openSet is not async');
  assert.deepEqual(events, [
    'https://library.example.com',
    'https://requests.example.com',
    'https://indexer.example.com',
  ]);

  return Promise.resolve().then(() => {
    assert.equal(events[events.length - 1], 'microtask');
  });
});

test('a partially valid set reports the unresolved target and opens the valid ones', () => {
  const set = { id: 'mixed', name: 'Mixed', targets: ['library', 'nope', 'dashboards'] };

  const resolved = resolveTargets(set, config);
  assert.deepEqual(resolved.unresolved, ['nope']);

  const { calls, open } = openRecorder();
  const result = openSet(set, config, { open });

  assert.equal(result.opened, 2);
  assert.deepEqual(
    calls.map((c) => c.url),
    ['https://library.example.com', 'https://dashboards.example.org'],
  );
});

test('an injected resolveTargets is used instead of the fallback', () => {
  const { calls, open } = openRecorder();

  const result = openSet({ id: 'x', name: 'X', targets: ['anything'] }, config, {
    open,
    resolveTargets: () => ({ items: [{ id: 'q', name: 'Q', url: 'https://q.example.com' }], unresolved: [] }),
  });

  assert.equal(result.opened, 1);
  assert.equal(calls[0].url, 'https://q.example.com');
});

test('an empty or missing target list opens nothing', () => {
  const { open } = openRecorder();

  assert.deepEqual(openSet({ id: 'e', name: 'E', targets: [] }, config, { open }), {
    opened: 0,
    blocked: [],
    confirmed: true,
  });
  assert.deepEqual(openSet({ id: 'e', name: 'E' }, config, { open }), {
    opened: 0,
    blocked: [],
    confirmed: true,
  });
});
