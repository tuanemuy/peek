import { describe, expect, it } from "vitest";
import {
  type FileTreeStateStore,
  getExpandedSet,
  parseStore,
  purgeExpired,
  serializeStore,
  TTL_MS,
  writeExpanded,
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
      abc: { expanded: ["a/b"], lastAccess: 123 },
    };
    expect(parseStore(JSON.stringify(store))).toEqual(store);
  });

  it("returns an empty store for null JSON", () => {
    expect(parseStore("null")).toEqual({});
  });

  it("drops entries whose expanded is not an array", () => {
    expect(parseStore('{"p":{"expanded":"x","lastAccess":1}}')).toEqual({});
  });

  it("drops entries whose lastAccess is not a number", () => {
    expect(parseStore('{"p":{"expanded":[],"lastAccess":"old"}}')).toEqual({});
  });

  it("drops entries that are not objects", () => {
    expect(parseStore('{"p":42}')).toEqual({});
  });

  it("excludes non-string elements from expanded", () => {
    expect(
      parseStore('{"p":{"expanded":["a",1,null,"b"],"lastAccess":5}}'),
    ).toEqual({ p: { expanded: ["a", "b"], lastAccess: 5 } });
  });

  it("drops entries in the former collapsed format", () => {
    expect(parseStore('{"p":{"collapsed":["a"],"lastAccess":1}}')).toEqual({});
  });

  it("keeps valid entries while dropping invalid ones", () => {
    const raw = JSON.stringify({
      good: { expanded: ["a"], lastAccess: 10 },
      bad: { expanded: "x", lastAccess: 20 },
    });
    expect(parseStore(raw)).toEqual({
      good: { expanded: ["a"], lastAccess: 10 },
    });
  });
});

describe("purgeExpired", () => {
  const now = 1_000_000_000_000;

  it("removes entries older than the TTL", () => {
    const store: FileTreeStateStore = {
      fresh: { expanded: [], lastAccess: now },
      stale: { expanded: ["x"], lastAccess: now - TTL_MS - 1 },
    };
    expect(purgeExpired(store, now, TTL_MS)).toEqual({
      fresh: { expanded: [], lastAccess: now },
    });
  });

  it("keeps entries exactly at the TTL boundary", () => {
    const store: FileTreeStateStore = {
      boundary: { expanded: [], lastAccess: now - TTL_MS },
    };
    expect(purgeExpired(store, now, TTL_MS)).toEqual(store);
  });

  it("does not mutate the input", () => {
    const store: FileTreeStateStore = {
      stale: { expanded: [], lastAccess: now - TTL_MS - 1 },
    };
    purgeExpired(store, now, TTL_MS);
    expect(store.stale).toBeDefined();
  });
});

describe("getExpandedSet", () => {
  it("returns an empty set when the project is absent", () => {
    expect(getExpandedSet({}, "missing")).toEqual(new Set());
  });

  it("returns the expanded paths as a set", () => {
    const store: FileTreeStateStore = {
      p: { expanded: ["a", "b"], lastAccess: 0 },
    };
    expect(getExpandedSet(store, "p")).toEqual(new Set(["a", "b"]));
  });
});

describe("writeExpanded", () => {
  it("updates expanded and lastAccess for the project", () => {
    const next = writeExpanded({}, "p", new Set(["a"]), 100);
    expect(next.p).toEqual({ expanded: ["a"], lastAccess: 100 });
  });

  it("keeps the entry when the expanded set is empty", () => {
    const next = writeExpanded({}, "p", new Set(), 100);
    expect(next.p).toEqual({ expanded: [], lastAccess: 100 });
  });

  it("does not affect other projects", () => {
    const store: FileTreeStateStore = {
      other: { expanded: ["x"], lastAccess: 1 },
    };
    const next = writeExpanded(store, "p", new Set(["a"]), 100);
    expect(next.other).toEqual({ expanded: ["x"], lastAccess: 1 });
  });

  it("replaces the project's previous expanded set", () => {
    const store: FileTreeStateStore = {
      p: { expanded: ["old"], lastAccess: 1 },
    };
    const next = writeExpanded(store, "p", new Set(["new"]), 100);
    expect(next.p).toEqual({ expanded: ["new"], lastAccess: 100 });
  });

  it("does not mutate the input store", () => {
    const store: FileTreeStateStore = {
      p: { expanded: [], lastAccess: 1 },
    };
    writeExpanded(store, "p", new Set(["a"]), 100);
    expect(store.p).toEqual({ expanded: [], lastAccess: 1 });
  });
});

describe("serializeStore", () => {
  it("round-trips through parseStore", () => {
    const store: FileTreeStateStore = {
      p: { expanded: ["a/b", "c"], lastAccess: 42 },
    };
    expect(parseStore(serializeStore(store))).toEqual(store);
  });
});
