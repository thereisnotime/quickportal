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
  slugify,
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
