// Tests for src/assets/config.js. One test per scenario in
// openspec/changes/config-driven-portal/specs/bookmark-config/spec.md, plus the
// set-resolution scenarios from specs/bookmark-sets/spec.md.

import test from "node:test";
import assert from "node:assert/strict";

import {
  CONFIG_VERSION,
  MAX_DEPTH,
  ROOT_PATH,
  DEFAULTS,
  parseConfig,
  normalizeConfig,
  indexItems,
  resolveTargets,
  isUsableUrl,
  isFramableUrl,
  slugify,
  FRAME_DEFAULT_MAX,
  ALLOW_TOKENS,
  SANDBOX_TOKENS,
} from "../src/assets/config.js";
import { load as yamlLoad } from "../src/assets/js-yaml.mjs";

const MINIMAL_YAML = `version: 1
groups:
  - name: Media
    items:
      - name: Library
        url: https://library.example.com
`;

/** Parse text and assert it produced no errors, returning the normalized config. */
function loadConfig(text) {
  const parsed = parseConfig(text);
  assert.deepEqual(parsed.errors, [], "unexpected parse errors");
  return normalizeConfig(parsed.raw);
}

function paths(issues) {
  return issues.map((issue) => issue.path);
}

function messageFor(issues, path) {
  const found = issues.find((issue) => issue.path === path);
  assert.ok(found, `no issue at path ${path}; got ${JSON.stringify(paths(issues))}`);
  return found.message;
}

// ---------------------------------------------------------------------------
// Requirement: Config is accepted as YAML or JSON
// ---------------------------------------------------------------------------

test("JSON config is parsed with JSON.parse and never reaches the YAML parser", () => {
  let yamlCalls = 0;
  const countingYaml = (text) => {
    yamlCalls += 1;
    return yamlLoad(text);
  };
  const json = JSON.stringify({ version: 1, title: "Home", groups: [] });

  const { raw, errors } = parseConfig(json, { yamlLoad: countingYaml });

  assert.deepEqual(errors, []);
  assert.equal(raw.title, "Home");
  assert.equal(yamlCalls, 0);
});

test("YAML config parses to the same shape as the equivalent JSON", () => {
  const fromYaml = loadConfig(MINIMAL_YAML);
  const fromJson = loadConfig(
    JSON.stringify({
      version: 1,
      groups: [{ name: "Media", items: [{ name: "Library", url: "https://library.example.com" }] }],
    }),
  );

  assert.deepEqual(fromYaml.errors, []);
  assert.deepEqual(fromYaml.config, fromJson.config);
});

test("a file that is neither JSON nor YAML reports the failure and its line", () => {
  const broken = `version: 1
groups:
  - name: Media
 url: https://library.example.com
`;

  const { raw, errors } = parseConfig(broken);

  assert.equal(raw, null);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].path, ROOT_PATH);
  // The YAML parser's own reason and position, not a generic message.
  assert.match(errors[0].message, /line 4/);
  assert.match(errors[0].message, /indentation/i);
});

test("an empty config file is reported rather than parsed as nothing", () => {
  const { raw, errors } = parseConfig("   \n  ");

  assert.equal(raw, null);
  assert.deepEqual(paths(errors), [ROOT_PATH]);
  assert.match(errors[0].message, /empty/);
});

test("a YAML document that is not a mapping is an error, not a crash", () => {
  const { config, errors } = normalizeConfig("just a string");

  assert.equal(config, null);
  assert.deepEqual(paths(errors), [ROOT_PATH]);
});

// ---------------------------------------------------------------------------
// Requirement: Config declares a schema version
// ---------------------------------------------------------------------------

test("version 1 is processed normally", () => {
  const { config, errors } = loadConfig(MINIMAL_YAML);

  assert.deepEqual(errors, []);
  assert.equal(config.version, CONFIG_VERSION);
});

test("a missing version is an error at path version", () => {
  const { config, errors } = normalizeConfig({ groups: [] });

  assert.equal(config, null);
  assert.deepEqual(paths(errors), ["version"]);
  assert.match(messageFor(errors, "version"), /required/);
});

test("a future version is an error and yields no config", () => {
  const { config, errors } = normalizeConfig({
    version: CONFIG_VERSION + 1,
    groups: [{ name: "Media", items: [{ name: "Library", url: "https://library.example.com" }] }],
  });

  assert.equal(config, null, "nothing may be rendered from a future version");
  assert.deepEqual(paths(errors), ["version"]);
  assert.match(messageFor(errors, "version"), /upgrade/i);
});

test("a non-numeric version is an error", () => {
  const { errors } = normalizeConfig({ version: "1" });

  assert.deepEqual(paths(errors), ["version"]);
});

// ---------------------------------------------------------------------------
// Requirement: Groups nest arbitrarily
// ---------------------------------------------------------------------------

test("nested groups are kept as a tree", () => {
  const { config, errors, warnings } = loadConfig(`version: 1
groups:
  - name: Infra
    groups:
      - name: Observability
        items:
          - name: Dashboards
            url: https://dashboards.example.com
`);

  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.equal(config.groups[0].groups[0].items[0].name, "Dashboards");
});

test("nesting past the depth limit warns and truncates instead of failing", () => {
  // Six levels: the sixth is dropped.
  let deepest = { name: "L6", items: [{ name: "Leaf", url: "https://leaf.example.com" }] };
  for (let level = MAX_DEPTH; level >= 1; level -= 1) {
    deepest = { name: `L${level}`, groups: [deepest] };
  }

  const { config, errors, warnings } = normalizeConfig({ version: 1, groups: [deepest] });

  assert.deepEqual(errors, [], "depth overflow is a warning, not an error");
  const warningPath = "groups[0].groups[0].groups[0].groups[0].groups[0].groups";
  assert.match(messageFor(warnings, warningPath), /truncated/);

  let node = config.groups[0];
  for (let level = 2; level <= MAX_DEPTH; level += 1) {
    assert.equal(node.groups.length, 1);
    node = node.groups[0];
  }
  assert.equal(node.name, `L${MAX_DEPTH}`);
  assert.deepEqual(node.groups, [], "the sixth level is truncated away");
});

// ---------------------------------------------------------------------------
// Requirement: Identifiers are stable and unique
// ---------------------------------------------------------------------------

test("ids are derived by slugifying the name within the parent path", () => {
  const { config, errors } = loadConfig(`version: 1
groups:
  - name: Media & TV
    items:
      - name: My Library
        url: https://library.example.com
`);

  assert.deepEqual(errors, []);
  assert.equal(config.groups[0].id, "media-tv");
  assert.equal(config.groups[0].items[0].id, "media-tv/my-library");
});

test("the same item name in two groups does not collide", () => {
  const { config, errors } = loadConfig(`version: 1
groups:
  - name: Media
    items:
      - name: Status
        url: https://media-status.example.com
  - name: Infra
    items:
      - name: Status
        url: https://infra-status.example.com
`);

  assert.deepEqual(errors, []);
  assert.equal(config.groups[0].items[0].id, "media/status");
  assert.equal(config.groups[1].items[0].id, "infra/status");
});

test("derived ids are stable across reloads of an unchanged config", () => {
  const first = loadConfig(MINIMAL_YAML).config;
  const second = loadConfig(MINIMAL_YAML).config;

  assert.deepEqual([...indexItems(first).keys()], [...indexItems(second).keys()]);
  assert.deepEqual([...indexItems(first).keys()], ["media/library"]);
});

test("an explicit id is used as given and anchors its children", () => {
  const { config } = loadConfig(`version: 1
groups:
  - id: media
    name: Media & TV
    items:
      - name: Library
        url: https://library.example.com
      - id: pinned
        name: Pinned
        url: https://pinned.example.com
`);

  assert.equal(config.groups[0].id, "media");
  assert.equal(config.groups[0].items[0].id, "media/library");
  assert.equal(config.groups[0].items[1].id, "pinned");
});

test("two entries resolving to the same id is an error naming both paths", () => {
  const { errors } = normalizeConfig({
    version: 1,
    groups: [
      {
        name: "Media",
        items: [
          { name: "Status", url: "https://a.example.com" },
          { name: "status", url: "https://b.example.com" },
        ],
      },
    ],
  });

  assert.equal(errors.length, 1);
  assert.equal(errors[0].path, "groups[0].items[1]");
  assert.match(errors[0].message, /groups\[0\]\.items\[0\]/);
  assert.match(errors[0].message, /media\/status/);
});

test("a duplicate explicit id is an error rather than last-one-wins", () => {
  const { config, errors } = normalizeConfig({
    version: 1,
    groups: [
      { id: "shared", name: "First", items: [{ name: "A", url: "https://a.example.com" }] },
      { id: "shared", name: "Second", items: [{ name: "B", url: "https://b.example.com" }] },
    ],
  });

  assert.equal(errors.length, 1);
  assert.equal(errors[0].path, "groups[1]");
  assert.match(errors[0].message, /groups\[0\]/);
  assert.equal(config.groups.length, 1);
  assert.equal(config.groups[0].name, "First", "the first definition is the one kept");
});

test("slugify collapses punctuation and trims hyphens", () => {
  assert.equal(slugify("  Media & TV!  "), "media-tv");
  assert.equal(slugify("Grafana 2.0"), "grafana-2-0");
  assert.equal(slugify("***"), "");
});

// ---------------------------------------------------------------------------
// Requirement: Optional fields have documented defaults
// ---------------------------------------------------------------------------

test("a minimal config renders with every documented default and no issues", () => {
  const { config, errors, warnings } = loadConfig(MINIMAL_YAML);

  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.equal(config.title, DEFAULTS.title);
  assert.equal(config.subtitle, DEFAULTS.subtitle);
  assert.equal(config.theme, DEFAULTS.theme);
  assert.equal(config.layout.density, DEFAULTS.density);
  assert.equal(config.layout.minCardWidth, DEFAULTS.minCardWidth);
  assert.equal(config.reload.interval, DEFAULTS.reloadInterval);
  assert.deepEqual(config.sets, []);

  const item = config.groups[0].items[0];
  assert.equal(item.target, DEFAULTS.target);
  assert.equal(item.description, "");
  assert.equal(item.icon, null);
  assert.deepEqual(item.tags, []);
  assert.equal(config.groups[0].collapsed, DEFAULTS.collapsed);
});

test("reload.interval 0 is kept, because it disables live reload", () => {
  const { config, warnings } = normalizeConfig({ version: 1, reload: { interval: 0 }, groups: [] });

  assert.deepEqual(warnings, []);
  assert.equal(config.reload.interval, 0);
});

test("every documented field round-trips", () => {
  const { config, errors, warnings } = loadConfig(`version: 1
title: Home
subtitle: Everything in one place
theme: dark
layout:
  density: compact
  minCardWidth: 18rem
reload:
  interval: 10
groups:
  - id: media
    name: Media
    icon: "M"
    collapsed: true
    items:
      - id: library
        name: Library
        url: https://library.example.com
        description: Films and shows
        icon: auto
        tags: [streaming, media]
        target: _self
sets:
  - id: morning
    name: Morning check
    icon: "S"
    targets: [library]
`);

  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.equal(config.title, "Home");
  assert.equal(config.theme, "dark");
  assert.equal(config.layout.density, "compact");
  assert.equal(config.layout.minCardWidth, "18rem");
  assert.equal(config.reload.interval, 10);
  assert.equal(config.groups[0].collapsed, true);
  assert.equal(config.groups[0].icon, "M");
  assert.deepEqual(config.groups[0].items[0].tags, ["streaming", "media"]);
  assert.equal(config.groups[0].items[0].target, "_self");
  assert.equal(config.sets[0].id, "morning");
});

// ---------------------------------------------------------------------------
// Warnings: a config written for a newer version still renders
// ---------------------------------------------------------------------------

test("unknown keys are warnings and the tree still renders", () => {
  const { config, errors, warnings } = normalizeConfig({
    version: 1,
    footer: "from a newer schema",
    layout: { density: "compact", columns: 3 },
    groups: [
      {
        name: "Media",
        badge: "new",
        items: [{ name: "Library", url: "https://library.example.com", colour: "red" }],
      },
    ],
  });

  assert.deepEqual(errors, []);
  assert.deepEqual(paths(warnings), [
    "footer",
    "layout.columns",
    "groups[0].badge",
    "groups[0].items[0].colour",
  ]);
  assert.match(messageFor(warnings, "footer"), /unknown key/);
  assert.equal(config.groups[0].items[0].name, "Library");
});

test("an out-of-range enum falls back with a warning", () => {
  const { config, errors, warnings } = normalizeConfig({
    version: 1,
    theme: "sepia",
    layout: { density: "roomy" },
    groups: [],
  });

  assert.deepEqual(errors, []);
  assert.deepEqual(paths(warnings), ["theme", "layout.density"]);
  assert.equal(config.theme, DEFAULTS.theme);
  assert.equal(config.layout.density, DEFAULTS.density);
});

// ---------------------------------------------------------------------------
// Type and URL validation
// ---------------------------------------------------------------------------

test("structural type errors carry the path of the offending value", () => {
  const { errors } = normalizeConfig({
    version: 1,
    groups: [{ name: "Media", items: { name: "Library" } }, "nope"],
  });

  assert.deepEqual(paths(errors), ["groups[0].items", "groups[1]"]);
});

test("an item without a name or a url is an error at the missing field", () => {
  const { errors } = normalizeConfig({
    version: 1,
    groups: [
      {
        name: "Media",
        items: [{ url: "https://library.example.com" }, { name: "No URL" }],
      },
    ],
  });

  assert.deepEqual(paths(errors), ["groups[0].items[0].name", "groups[0].items[1].url"]);
});

test("relative URLs and non-HTTP schemes are accepted", () => {
  for (const url of [
    "https://library.example.com",
    "http://library.example.com:8080/path?q=1#frag",
    "/grafana",
    "./status.html",
    "ssh://shell.example.com",
    "vnc://desktop.example.com:5900",
    "mailto:admin@example.com",
    "magnet:?xt=urn:btih:0000",
  ]) {
    assert.equal(isUsableUrl(url), true, `${url} should be accepted`);
  }

  const { config, errors } = normalizeConfig({
    version: 1,
    groups: [
      {
        name: "Mixed",
        items: [
          { name: "Relative", url: "/grafana" },
          { name: "Shell", url: "ssh://shell.example.com" },
        ],
      },
    ],
  });
  assert.deepEqual(errors, []);
  assert.equal(config.groups[0].items[0].url, "/grafana");
});

test("text that is not a URL is rejected", () => {
  for (const url of ["not a url", "http://", "", "   ", "two words.example.com/x"]) {
    assert.equal(isUsableUrl(url), false, `${JSON.stringify(url)} should be rejected`);
  }

  const { errors } = normalizeConfig({
    version: 1,
    groups: [{ name: "Media", items: [{ name: "Broken", url: "not a url" }] }],
  });
  assert.deepEqual(paths(errors), ["groups[0].items[0].url"]);
});

test("a javascript: bookmark is refused", () => {
  const { errors } = normalizeConfig({
    version: 1,
    groups: [{ name: "Media", items: [{ name: "Bad", url: "javascript:alert(1)" }] }],
  });

  assert.deepEqual(paths(errors), ["groups[0].items[0].url"]);
  assert.match(errors[0].message, /not allowed/);
});

// ---------------------------------------------------------------------------
// indexItems and resolveTargets
// ---------------------------------------------------------------------------

const SETS_CONFIG = `version: 1
groups:
  - id: media
    name: Media
    items:
      - id: library
        name: Library
        url: https://library.example.com
      - name: Requests
        url: https://requests.example.com
    groups:
      - id: downloads
        name: Downloads
        items:
          - id: queue
            name: Queue
            url: https://queue.example.com
  - id: infra
    name: Infra
    items:
      - id: dashboards
        name: Dashboards
        url: https://dashboards.example.com
sets:
  - id: morning
    name: Morning check
    targets: [library, dashboards, "https://status.example.com"]
  - id: all-media
    name: All media
    targets: [media]
`;

test("indexItems maps every item depth-first in config order", () => {
  const { config, errors } = loadConfig(SETS_CONFIG);

  assert.deepEqual(errors, []);
  assert.deepEqual(
    [...indexItems(config).keys()],
    ["library", "media/requests", "queue", "dashboards"],
  );
});

test("a set of three resolvable targets resolves to three items", () => {
  const { config } = loadConfig(SETS_CONFIG);

  const { items, unresolved } = resolveTargets(config.sets[0], config);

  assert.deepEqual(unresolved, []);
  assert.deepEqual(
    items.map((item) => item.url),
    [
      "https://library.example.com",
      "https://dashboards.example.com",
      "https://status.example.com",
    ],
  );
});

test("a bare URL target resolves to a synthetic item opened as given", () => {
  const { config } = loadConfig(SETS_CONFIG);

  const { items } = resolveTargets({ targets: ["https://status.example.com"] }, config);

  assert.equal(items.length, 1);
  assert.equal(items[0].url, "https://status.example.com");
  assert.equal(items[0].id, null);
  assert.equal(items[0].synthetic, true);
});

test("a group target resolves to every item beneath it, depth-first in config order", () => {
  const { config } = loadConfig(SETS_CONFIG);

  const { items, unresolved } = resolveTargets(config.sets[1], config);

  assert.deepEqual(unresolved, []);
  assert.deepEqual(
    items.map((item) => item.id),
    ["library", "media/requests", "queue"],
  );
});

test("a target resolving to an already-included URL is not opened twice", () => {
  const { config } = loadConfig(SETS_CONFIG);

  const { items } = resolveTargets({ targets: ["media", "library", "queue"] }, config);

  assert.deepEqual(
    items.map((item) => item.id),
    ["library", "media/requests", "queue"],
  );
});

test("a mistyped target is unresolved at validation time, naming the set and the target", () => {
  const { config, errors } = normalizeConfig({
    version: 1,
    groups: [{ id: "infra", name: "Infra", items: [{ id: "dashboards", name: "D", url: "https://d.example.com" }] }],
    sets: [{ id: "morning", name: "Morning check", targets: ["dashboars"] }],
  });

  assert.deepEqual(paths(errors), ["sets[0].targets[0]"]);
  assert.match(errors[0].message, /Morning check/);
  assert.match(errors[0].message, /dashboars/);
  assert.deepEqual(resolveTargets(config.sets[0], config).unresolved, ["dashboars"]);
});

test("a partially valid set keeps its resolvable targets", () => {
  const { config, errors } = normalizeConfig({
    version: 1,
    groups: [{ id: "infra", name: "Infra", items: [{ id: "dashboards", name: "D", url: "https://d.example.com" }] }],
    sets: [{ id: "morning", name: "Morning check", targets: ["dashboards", "typo"] }],
  });

  assert.deepEqual(paths(errors), ["sets[0].targets[1]"]);
  const { items, unresolved } = resolveTargets(config.sets[0], config);
  assert.deepEqual(
    items.map((item) => item.id),
    ["dashboards"],
  );
  assert.deepEqual(unresolved, ["typo"]);
});

test("a set with no targets is an error", () => {
  const { errors } = normalizeConfig({
    version: 1,
    groups: [],
    sets: [{ name: "Empty", targets: [] }],
  });

  assert.deepEqual(paths(errors), ["sets[0].targets"]);
});

test("duplicate set ids are an error naming both paths", () => {
  const { errors } = normalizeConfig({
    version: 1,
    groups: [{ id: "infra", name: "Infra", items: [{ id: "d", name: "D", url: "https://d.example.com" }] }],
    sets: [
      { name: "Morning check", targets: ["d"] },
      { name: "Morning Check", targets: ["d"] },
    ],
  });

  assert.equal(errors.length, 1);
  assert.equal(errors[0].path, "sets[1]");
  assert.match(errors[0].message, /sets\[0\]/);
});

test("resolveTargets tolerates a set with no targets and an empty config", () => {
  assert.deepEqual(resolveTargets({}, { groups: [] }), { items: [], unresolved: [] });
  assert.deepEqual(resolveTargets({ targets: ["x"] }, {}), { items: [], unresolved: ["x"] });
});

// --- Regression -------------------------------------------------------------
//
// Derived ids used to accumulate the parent chain twice from depth three on, so
// a depth-four item came out as media/media/downloads/media/.../deeper. These
// ids are what sets reference and what collapse state is keyed by, so they are
// user-facing and a rename of this shape is a breaking change.

test("derived ids qualify each level exactly once, to the depth cap", () => {
  const yaml = `version: 1
groups:
  - name: Media
    items:
      - name: Library
        url: https://library.example.com
    groups:
      - name: Downloads
        items:
          - name: Queue
            url: https://queue.example.com
        groups:
          - name: Deeper
            items:
              - name: Thing
                url: https://thing.example.com
            groups:
              - name: Deepest
                items:
                  - name: Last
                    url: https://last.example.com
`;
  const { config, errors } = normalizeConfig(parseConfig(yaml).raw);
  assert.deepEqual(errors, []);

  const ids = [];
  const walk = (groups) => {
    for (const group of groups) {
      ids.push(group.id);
      for (const item of group.items) ids.push(item.id);
      walk(group.groups);
    }
  };
  walk(config.groups);

  assert.deepEqual(ids, [
    "media",
    "media/library",
    "media/downloads",
    "media/downloads/queue",
    "media/downloads/deeper",
    "media/downloads/deeper/thing",
    "media/downloads/deeper/deepest",
    "media/downloads/deeper/deepest/last",
  ]);
  for (const id of ids) {
    assert.equal(/(^|\/)([^/]+)\/\2(\/|$)/.test(id), false, `${id} repeats a segment`);
  }
});

test("a sibling name under two parents does not collide", () => {
  const yaml = `version: 1
groups:
  - name: One
    items:
      - name: Status
        url: https://one.example.com/status
  - name: Two
    items:
      - name: Status
        url: https://two.example.com/status
`;
  const { config, errors } = normalizeConfig(parseConfig(yaml).raw);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    [config.groups[0].items[0].id, config.groups[1].items[0].id],
    ["one/status", "two/status"],
  );
});

// ---------------------------------------------------------------------------
// Requirement: Embedding fields are validated
// (openspec/changes/embedded-app-tabs/specs/bookmark-config/spec.md)
// ---------------------------------------------------------------------------

/** A one-item config whose item carries the given extra YAML lines. */
function itemWith(lines, url = "https://dashboards.example.com") {
  const extra = lines.map((line) => `        ${line}`).join("\n");
  return `version: 1
groups:
  - name: Apps
    items:
      - name: Dashboards
        url: ${url}
${extra}
`;
}

test("an item with embed: true and a known allow token is accepted and marked embedded", () => {
  const { config, errors, warnings } = loadConfig(itemWith(["embed: true", "allow: [fullscreen]"]));

  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, [], "nothing here is questionable");
  const item = config.groups[0].items[0];
  assert.equal(item.embed, true);
  assert.deepEqual(item.allow, ["fullscreen"]);
  assert.deepEqual(item.sandbox, [], "sandbox is opt-in and stays empty");
  assert.equal(config.embedding.enabled, true, "the config summary says embedding is in use");
  assert.deepEqual(config.embedding.itemIds, [item.id], "and names the embedded item");
});

test("an item that does not opt in defaults to not embedded", () => {
  const { config, errors, warnings } = loadConfig(MINIMAL_YAML);

  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  const item = config.groups[0].items[0];
  assert.equal(item.embed, DEFAULTS.embed);
  assert.equal(item.embed, false);
  assert.deepEqual(item.allow, []);
  assert.deepEqual(item.sandbox, []);
  assert.equal(config.embedding.enabled, false);
  assert.deepEqual(config.embedding.itemIds, []);
  assert.equal(config.embedding.maxFrames, DEFAULTS.maxFrames);
});

test("embed with the wrong type warns and falls back to the documented default", () => {
  const { config, errors, warnings } = loadConfig(itemWith(['embed: "yes"']));

  assert.deepEqual(errors, []);
  const message = messageFor(warnings, "groups[0].items[0].embed");
  assert.match(message, /true or false/);
  assert.equal(config.groups[0].items[0].embed, DEFAULTS.embed);
});

test("an unknown allow token is named, dropped, and never reaches the frame", () => {
  const { config, errors, warnings } = loadConfig(
    itemWith(["embed: true", "allow: [fullscreen, teleportation]"]),
  );

  assert.deepEqual(errors, []);
  const message = messageFor(warnings, "groups[0].items[0].allow[1]");
  assert.match(message, /teleportation/, "the warning names the offending token");
  assert.deepEqual(config.groups[0].items[0].allow, ["fullscreen"]);
});

test("an unknown sandbox token is named and dropped the same way", () => {
  const { config, errors, warnings } = loadConfig(
    itemWith(["embed: true", "sandbox: [allow-forms, allow-everything]"]),
  );

  assert.deepEqual(errors, []);
  assert.match(messageFor(warnings, "groups[0].items[0].sandbox[1]"), /allow-everything/);
  assert.deepEqual(config.groups[0].items[0].sandbox, ["allow-forms"]);
});

test("allow and sandbox that are not lists are ignored with a warning", () => {
  const { config, errors, warnings } = loadConfig(
    itemWith(["embed: true", "allow: fullscreen", "sandbox: 3"]),
  );

  assert.deepEqual(errors, []);
  assert.match(messageFor(warnings, "groups[0].items[0].allow"), /list of permission tokens/);
  assert.match(messageFor(warnings, "groups[0].items[0].sandbox"), /list of sandbox tokens/);
  assert.deepEqual(config.groups[0].items[0].allow, []);
  assert.deepEqual(config.groups[0].items[0].sandbox, []);
});

test("allow-scripts with allow-same-origin warns that the sandbox protects nothing", () => {
  const { config, errors, warnings } = loadConfig(
    itemWith(["embed: true", "sandbox: [allow-scripts, allow-same-origin]"]),
  );

  assert.deepEqual(errors, []);
  const message = messageFor(warnings, "groups[0].items[0].sandbox");
  assert.match(message, /no protection/);
  assert.deepEqual(
    config.groups[0].items[0].sandbox,
    ["allow-scripts", "allow-same-origin"],
    "honoured, but never quietly",
  );
});

test("allow or sandbox without embed warns that they do nothing", () => {
  const { errors, warnings } = loadConfig(itemWith(["allow: [fullscreen]"]));

  assert.deepEqual(errors, []);
  assert.match(messageFor(warnings, "groups[0].items[0]"), /only apply to an embedded item/);
});

test("the new embedding keys do not trip the unknown-key warning", () => {
  const { errors, warnings } = loadConfig(`version: 1
embedding:
  maxFrames: 2
groups:
  - name: Apps
    items:
      - name: Dashboards
        url: https://dashboards.example.com
        embed: true
        allow: [clipboard-write]
        sandbox: []
`);

  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test("embed: true on a scheme that cannot be framed warns and keeps the bookmark", () => {
  for (const url of ["mailto:ops@example.com", "magnet:?xt=urn:btih:abc", "tel:+10000000"]) {
    const { config, errors, warnings } = loadConfig(itemWith(["embed: true"], url));

    // The embed request is impossible; the bookmark is not. Dropping the entry
    // would cost a working link over a field that can be ignored.
    assert.deepEqual(errors, [], `${url} should not be an error`);
    const message = messageFor(warnings, "groups[0].items[0].embed");
    assert.match(message, /cannot be framed/, `${url} should warn about embedding`);

    const item = config.groups[0].items[0];
    assert.equal(item.url, url, "the bookmark survives");
    assert.equal(item.embed, false, "and falls back to opening in a browser tab");
    assert.equal(config.embedding.itemIds.includes(item.id), false, "so it is not in the embedded set");
  }
});

test("the same non-framable schemes stay perfectly good bookmarks when not embedded", () => {
  const { config, errors, warnings } = loadConfig(itemWith([], "mailto:ops@example.com"));

  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.equal(config.groups[0].items[0].url, "mailto:ops@example.com");
});

test("an embedded relative URL and an embedded http(s) URL are both fine", () => {
  for (const url of ["/grafana", "./status", "http://apps.example.org", "https://apps.example.org"]) {
    const { config, errors } = loadConfig(itemWith(["embed: true"], url));
    assert.deepEqual(errors, [], `${url} should be framable`);
    assert.equal(config.groups[0].items[0].embed, true);
  }
});

test("isFramableUrl agrees with isUsableUrl about what is a URL at all", () => {
  assert.equal(isFramableUrl("https://apps.example.com"), true);
  assert.equal(isFramableUrl("/relative"), true);
  assert.equal(isFramableUrl("mailto:ops@example.com"), false);
  assert.equal(isFramableUrl("magnet:?xt=urn:btih:abc"), false);
  assert.equal(isFramableUrl("not a url"), false);
  assert.equal(isUsableUrl("not a url"), false);
  assert.equal(isFramableUrl(""), false);
});

test("a bad embedding.maxFrames warns and uses the documented default", () => {
  for (const value of ["0", "-3", "2.5", "999", '"four"']) {
    const { config, errors, warnings } = loadConfig(`version: 1
embedding:
  maxFrames: ${value}
groups:
  - name: Apps
    items:
      - name: Dashboards
        url: https://dashboards.example.com
`);
    assert.deepEqual(errors, [], `maxFrames ${value} is a warning, not an error`);
    assert.match(messageFor(warnings, "embedding.maxFrames"), /between 1 and/);
    assert.equal(config.embedding.maxFrames, DEFAULTS.maxFrames);
  }
});

test("a usable embedding.maxFrames is kept, and the default matches the design constant", () => {
  const { config, errors, warnings } = loadConfig(`version: 1
embedding:
  maxFrames: 2
groups: []
`);

  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.equal(config.embedding.maxFrames, 2);
  assert.equal(FRAME_DEFAULT_MAX, DEFAULTS.maxFrames);
  assert.equal(FRAME_DEFAULT_MAX, 4);
});

test("an embedding block that is not a mapping warns and leaves the defaults", () => {
  const { config, errors, warnings } = loadConfig(`version: 1
embedding: 4
groups: []
`);

  assert.deepEqual(errors, []);
  assert.match(messageFor(warnings, "embedding"), /expected a mapping/);
  assert.equal(config.embedding.maxFrames, DEFAULTS.maxFrames);
});

test("an unknown key inside embedding is warned about, not silently accepted", () => {
  const { errors, warnings } = loadConfig(`version: 1
embedding:
  maxFrames: 2
  maxTabs: 9
groups: []
`);

  assert.deepEqual(errors, []);
  assert.deepEqual(paths(warnings), ["embedding.maxTabs"]);
});

test("embedding.itemIds lists every embedded item in render order", () => {
  const { config, errors } = loadConfig(`version: 1
groups:
  - name: Apps
    items:
      - name: One
        url: https://one.example.com
        embed: true
      - name: Two
        url: https://two.example.com
    groups:
      - name: Nested
        items:
          - name: Three
            url: https://three.example.com
            embed: true
`);

  assert.deepEqual(errors, []);
  assert.deepEqual(config.embedding.itemIds, ["apps/one", "apps/nested/three"]);
});

test("the recognised token sets are the only place the vocabulary is written down", () => {
  assert.ok(ALLOW_TOKENS.includes("fullscreen"));
  assert.ok(ALLOW_TOKENS.includes("clipboard-read") && ALLOW_TOKENS.includes("clipboard-write"));
  for (const sensitive of ["camera", "microphone", "geolocation", "display-capture"]) {
    assert.equal(ALLOW_TOKENS.includes(sensitive), false, `${sensitive} must not be delegable`);
  }
  assert.ok(SANDBOX_TOKENS.every((token) => token.startsWith("allow-")));
  assert.equal(Object.isFrozen(ALLOW_TOKENS), true);
  assert.equal(Object.isFrozen(SANDBOX_TOKENS), true);
});
