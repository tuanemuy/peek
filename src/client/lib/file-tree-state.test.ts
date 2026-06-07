import { describe, expect, it } from "vitest";
import {
  type FileTreeStateStore,
  getCollapsedSet,
  parseStore,
  purgeExpired,
  serializeStore,
  TTL_MS,
  writeCollapsed,
} from "./file-tree-state.js";

describe("parseStore", () => {
  it("returns an empty store for null", () => {
    expect(parseStore(null)).toEqual({});
  });

  it("returns an empty store for invalid JSON", () => {
    expect(parseStore("{not json")).toEqual({});
  });

  it("returns an empty store for non-object JSON", () => {
    expect(parseStore("[]")).toEqual({});
    expect(parseStore("42")).toEqual({});
  });

  it("parses a valid store", () => {
    const store: FileTreeStateStore = {
      abc: { collapsed: ["a/b"], lastAccess: 123 },
    };
    expect(parseStore(JSON.stringify(store))).toEqual(store);
  });

  it("returns an empty store for null JSON", () => {
    expect(parseStore("null")).toEqual({});
  });

  it("drops entries whose collapsed is not an array", () => {
    expect(parseStore('{"p":{"collapsed":"x","lastAccess":1}}')).toEqual({});
  });

  it("drops entries whose lastAccess is not a number", () => {
    expect(parseStore('{"p":{"collapsed":[],"lastAccess":"old"}}')).toEqual({});
  });

  it("drops entries that are not objects", () => {
    expect(parseStore('{"p":42}')).toEqual({});
  });

  it("excludes non-string elements from collapsed", () => {
    expect(
      parseStore('{"p":{"collapsed":["a",1,null,"b"],"lastAccess":5}}'),
    ).toEqual({ p: { collapsed: ["a", "b"], lastAccess: 5 } });
  });

  it("keeps valid entries while dropping invalid ones", () => {
    const raw = JSON.stringify({
      good: { collapsed: ["a"], lastAccess: 10 },
      bad: { collapsed: "x", lastAccess: 20 },
    });
    expect(parseStore(raw)).toEqual({
      good: { collapsed: ["a"], lastAccess: 10 },
    });
  });
});

describe("purgeExpired", () => {
  const now = 1_000_000_000_000;

  it("removes entries older than the TTL", () => {
    const store: FileTreeStateStore = {
      fresh: { collapsed: [], lastAccess: now },
      stale: { collapsed: ["x"], lastAccess: now - TTL_MS - 1 },
    };
    expect(purgeExpired(store, now, TTL_MS)).toEqual({
      fresh: { collapsed: [], lastAccess: now },
    });
  });

  it("keeps entries exactly at the TTL boundary", () => {
    const store: FileTreeStateStore = {
      boundary: { collapsed: [], lastAccess: now - TTL_MS },
    };
    expect(purgeExpired(store, now, TTL_MS)).toEqual(store);
  });

  it("does not mutate the input", () => {
    const store: FileTreeStateStore = {
      stale: { collapsed: [], lastAccess: now - TTL_MS - 1 },
    };
    purgeExpired(store, now, TTL_MS);
    expect(store.stale).toBeDefined();
  });
});

describe("getCollapsedSet", () => {
  it("returns an empty set when the project is absent", () => {
    expect(getCollapsedSet({}, "missing")).toEqual(new Set());
  });

  it("returns the collapsed paths as a set", () => {
    const store: FileTreeStateStore = {
      p: { collapsed: ["a", "b"], lastAccess: 0 },
    };
    expect(getCollapsedSet(store, "p")).toEqual(new Set(["a", "b"]));
  });
});

describe("writeCollapsed", () => {
  it("updates collapsed and lastAccess for the project", () => {
    const next = writeCollapsed({}, "p", new Set(["a"]), 100);
    expect(next.p).toEqual({ collapsed: ["a"], lastAccess: 100 });
  });

  it("keeps the entry when the collapsed set is empty", () => {
    const next = writeCollapsed({}, "p", new Set(), 100);
    expect(next.p).toEqual({ collapsed: [], lastAccess: 100 });
  });

  it("does not affect other projects", () => {
    const store: FileTreeStateStore = {
      other: { collapsed: ["x"], lastAccess: 1 },
    };
    const next = writeCollapsed(store, "p", new Set(["a"]), 100);
    expect(next.other).toEqual({ collapsed: ["x"], lastAccess: 1 });
  });

  it("does not mutate the input store", () => {
    const store: FileTreeStateStore = {
      p: { collapsed: [], lastAccess: 1 },
    };
    writeCollapsed(store, "p", new Set(["a"]), 100);
    expect(store.p).toEqual({ collapsed: [], lastAccess: 1 });
  });
});

describe("serializeStore", () => {
  it("round-trips through parseStore", () => {
    const store: FileTreeStateStore = {
      p: { collapsed: ["a/b", "c"], lastAccess: 42 },
    };
    expect(parseStore(serializeStore(store))).toEqual(store);
  });
});
