// Tests for src/assets/state.js. No DOM: every function takes the storage
// object as its last argument, and the no-storage path is exercised explicitly.

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_THEME,
  getTheme,
  getStoredTheme,
  setTheme,
  isCollapsed,
  setCollapsed,
  getQuery,
  setQuery,
  getOpenTabs,
  setOpenTabs,
  getDiagramOpen,
  setDiagramOpen,
  createMemoryStorage,
} from "../src/assets/state.js";

/** A storage object that throws on every access, like a blocked private window. */
function hostileStorage() {
  return {
    getItem() {
      throw new DOMExceptionLike("storage is blocked");
    },
    setItem() {
      throw new DOMExceptionLike("storage is blocked");
    },
    removeItem() {
      throw new DOMExceptionLike("storage is blocked");
    },
  };
}

class DOMExceptionLike extends Error {}

/** Storage that is present but full, so reads work and writes fail. */
function fullStorage(initial = {}) {
  const store = createMemoryStorage(initial);
  return {
    getItem: (key) => store.getItem(key),
    setItem() {
      throw new DOMExceptionLike("QuotaExceededError");
    },
    removeItem: (key) => store.removeItem(key),
  };
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

test("theme defaults to auto and round-trips through storage", () => {
  const storage = createMemoryStorage();

  assert.equal(getTheme(storage), DEFAULT_THEME);
  assert.equal(setTheme("dark", storage), true);
  assert.equal(getTheme(storage), "dark");
  assert.equal(setTheme("light", storage), true);
  assert.equal(getTheme(storage), "light");
});

test("an unknown theme is neither stored nor returned", () => {
  const storage = createMemoryStorage({ "quickportal.theme": "sepia" });

  assert.equal(getTheme(storage), DEFAULT_THEME, "junk in storage falls back to the default");
  assert.equal(setTheme("sepia", storage), false);
  assert.equal(setTheme(undefined, storage), false);
});

// ---------------------------------------------------------------------------
// Collapse state
// ---------------------------------------------------------------------------

test("collapse state falls back to the config's initial state until it is set", () => {
  const storage = createMemoryStorage();

  assert.equal(isCollapsed("media", false, storage), false);
  assert.equal(isCollapsed("media", true, storage), true, "the config's collapsed: true is honoured");

  setCollapsed("media", false, storage);
  assert.equal(isCollapsed("media", true, storage), false, "a remembered choice wins over the config");
});

test("collapse state is remembered per id and ids do not interfere", () => {
  const storage = createMemoryStorage();

  setCollapsed("media", true, storage);
  setCollapsed("media/downloads", false, storage);
  setCollapsed("infra", true, storage);

  assert.equal(isCollapsed("media", false, storage), true);
  assert.equal(isCollapsed("media/downloads", true, storage), false);
  assert.equal(isCollapsed("infra", false, storage), true);
  assert.equal(isCollapsed("unseen", false, storage), false);
});

test("a corrupt collapse entry is ignored rather than thrown", () => {
  for (const raw of ["not json", "[]", "null", '"text"']) {
    const storage = createMemoryStorage({ "quickportal.collapsed": raw });
    assert.equal(isCollapsed("media", true, storage), true);
    assert.equal(setCollapsed("media", false, storage), true);
    assert.equal(isCollapsed("media", true, storage), false);
  }
});

test("a non-boolean remembered value falls back to the given state", () => {
  const storage = createMemoryStorage({ "quickportal.collapsed": '{"media":"yes"}' });

  assert.equal(isCollapsed("media", true, storage), true);
  assert.equal(isCollapsed("media", false, storage), false);
});

test("setCollapsed refuses an empty id", () => {
  const storage = createMemoryStorage();

  assert.equal(setCollapsed("", true, storage), false);
  assert.equal(setCollapsed(undefined, true, storage), false);
});

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

test("the query round-trips and clearing it removes the key", () => {
  const storage = createMemoryStorage();

  assert.equal(getQuery(storage), "");
  assert.equal(setQuery("grafana", storage), true);
  assert.equal(getQuery(storage), "grafana");

  assert.equal(setQuery("", storage), true);
  assert.equal(getQuery(storage), "");
  assert.equal(storage.getItem("quickportal.query"), null);
});

test("a non-string query is treated as empty", () => {
  const storage = createMemoryStorage({ "quickportal.query": "old" });

  setQuery(null, storage);
  assert.equal(getQuery(storage), "");
});

// ---------------------------------------------------------------------------
// Storage that is absent, blocked or full
// ---------------------------------------------------------------------------

test("with no usable storage every getter returns its default and setters report failure", () => {
  // Called with no storage argument: under Node there is no working
  // localStorage to fall back to, which is the same situation as a browser that
  // blocks it.
  assert.equal(getTheme(), DEFAULT_THEME);
  assert.equal(getQuery(), "");
  assert.equal(isCollapsed("media", true), true);

  assert.equal(setTheme("dark"), false);
  assert.equal(setCollapsed("media", true), false);
  assert.equal(setQuery("grafana"), false);
});

test("a storage object missing the Storage methods is treated as no storage", () => {
  const storage = {};

  assert.equal(getTheme(storage), DEFAULT_THEME);
  assert.equal(getQuery(storage), "");
  assert.equal(isCollapsed("media", true, storage), true);
  assert.equal(setTheme("dark", storage), false);
  assert.equal(setQuery("grafana", storage), false);
});

test("storage that throws on every access still renders defaults", () => {
  const storage = hostileStorage();

  assert.equal(getTheme(storage), DEFAULT_THEME);
  assert.equal(getQuery(storage), "");
  assert.equal(isCollapsed("media", true, storage), true);
  assert.equal(setTheme("dark", storage), false);
  assert.equal(setCollapsed("media", true, storage), false);
  assert.equal(setQuery("grafana", storage), false);
});

test("a full storage reports the failed write but keeps reading", () => {
  const storage = fullStorage({ "quickportal.theme": "dark" });

  assert.equal(getTheme(storage), "dark");
  assert.equal(setTheme("light", storage), false);
  assert.equal(getTheme(storage), "dark", "the earlier value is untouched");
});

test("a getter that throws inside the property access is survivable", () => {
  const storage = {
    get getItem() {
      throw new DOMExceptionLike("blocked");
    },
  };

  assert.throws(() => storage.getItem, DOMExceptionLike, "the stub really does throw");
  assert.doesNotThrow(() => getTheme(storage));
  assert.equal(getTheme(storage), DEFAULT_THEME);
});

// --- Regression -------------------------------------------------------------
//
// getTheme() answers "auto" for both a remembered "auto" and for nothing
// remembered, so a caller could not tell a deliberate choice from an absent
// one, and a config's own `theme` either always won or always lost.

test("getStoredTheme distinguishes a deliberate auto from no choice at all", () => {
  const storage = createMemoryStorage();
  assert.equal(getStoredTheme(storage), null, "nothing remembered yet");
  assert.equal(getTheme(storage), DEFAULT_THEME, "getTheme still defaults");

  setTheme("auto", storage);
  assert.equal(getStoredTheme(storage), "auto", "a deliberate auto is a choice");

  setTheme("dark", storage);
  assert.equal(getStoredTheme(storage), "dark");
});

test("getStoredTheme rejects junk and survives storage being unavailable", () => {
  const storage = createMemoryStorage();
  storage.setItem("quickportal.theme", "chartreuse");
  assert.equal(getStoredTheme(storage), null);

  const hostile = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
    removeItem() {},
  };
  assert.equal(getStoredTheme(hostile), null);
});

// ---------------------------------------------------------------------------
// The open tab set, remembered like the other per-viewer preferences
// ---------------------------------------------------------------------------

test("the open tab set round-trips in strip order", () => {
  const storage = createMemoryStorage();
  assert.deepEqual(getOpenTabs(storage), [], "nothing remembered yet");

  assert.equal(setOpenTabs(["apps/dashboards", "apps/logs"], storage), true);
  assert.deepEqual(getOpenTabs(storage), ["apps/dashboards", "apps/logs"]);
});

test("an empty set is removed rather than stored", () => {
  const storage = createMemoryStorage();
  setOpenTabs(["apps/dashboards"], storage);

  assert.equal(setOpenTabs([], storage), true);
  assert.equal(storage.getItem("quickportal.openTabs"), null, "the key is gone, not an empty list");
  assert.deepEqual(getOpenTabs(storage), []);
});

test("junk under the key is discarded instead of reaching the frame host", () => {
  const storage = createMemoryStorage();
  for (const junk of ["not json", '"a string"', "{}", "17"]) {
    storage.setItem("quickportal.openTabs", junk);
    assert.deepEqual(getOpenTabs(storage), [], `junk: ${junk}`);
  }

  storage.setItem("quickportal.openTabs", JSON.stringify(["ok", "", 3, null, "ok"]));
  assert.deepEqual(getOpenTabs(storage), ["ok"], "non-ids and duplicates are dropped");
});

test("writing a set filters the ids it is given", () => {
  const storage = createMemoryStorage();
  setOpenTabs(["one", "", null, "one", "two", 5], storage);
  assert.deepEqual(getOpenTabs(storage), ["one", "two"]);

  assert.equal(setOpenTabs("not a list", storage), true, "nothing usable means nothing remembered");
  assert.deepEqual(getOpenTabs(storage), []);
});

test("the open tab set survives storage being unavailable or full", () => {
  const hostile = hostileStorage();
  assert.deepEqual(getOpenTabs(hostile), []);
  assert.equal(setOpenTabs(["apps/dashboards"], hostile), false);

  const full = fullStorage();
  assert.equal(setOpenTabs(["apps/dashboards"], full), false, "a failed write is reported");
  assert.deepEqual(getOpenTabs(full), []);
});

// ---------------------------------------------------------------------------
// The diagram panel's open state, remembered like the collapse state
// ---------------------------------------------------------------------------

test("the diagram panel's open state round-trips and defaults to closed", () => {
  const storage = createMemoryStorage();
  assert.equal(getDiagramOpen(storage), false, "nothing remembered means closed, so nothing is fetched");

  assert.equal(setDiagramOpen(true, storage), true);
  assert.equal(getDiagramOpen(storage), true);
});

test("a closed panel is removed rather than stored", () => {
  const storage = createMemoryStorage();
  setDiagramOpen(true, storage);

  assert.equal(setDiagramOpen(false, storage), true);
  assert.equal(storage.getItem("quickportal.diagramOpen"), null, "the key is gone, not a stored false");
  assert.equal(getDiagramOpen(storage), false);
});

test("junk under the diagram key reads as closed", () => {
  const storage = createMemoryStorage();
  for (const junk of ["false", "1", "yes", "{}", ""]) {
    storage.setItem("quickportal.diagramOpen", junk);
    assert.equal(getDiagramOpen(storage), false, `junk: ${junk}`);
  }
});

test("a non-boolean open state is coerced rather than rejected", () => {
  const storage = createMemoryStorage();
  assert.equal(setDiagramOpen("yes", storage), true);
  assert.equal(getDiagramOpen(storage), true);

  assert.equal(setDiagramOpen(0, storage), true);
  assert.equal(getDiagramOpen(storage), false);
});

test("the diagram panel state survives storage being unavailable or full", () => {
  const hostile = hostileStorage();
  assert.equal(getDiagramOpen(hostile), false);
  assert.equal(setDiagramOpen(true, hostile), false);

  const full = fullStorage();
  assert.equal(setDiagramOpen(true, full), false, "a failed write is reported");
  assert.equal(getDiagramOpen(full), false);

  assert.equal(getDiagramOpen(null), false, "no storage at all is the closed default");
});
