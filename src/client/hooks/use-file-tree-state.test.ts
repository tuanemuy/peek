import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FILE_TREE_STATE_KEY,
  type FileTreeStateStore,
  TTL_MS,
} from "../lib/file-tree-state.js";

// Minimal hook renderer (no DOM): hooks are stored in call order, layout
// effects run after each render when their deps change, and state updates
// trigger another render until the state settles.
const renderer = vi.hoisted(() => ({
  slots: [] as unknown[],
  index: 0,
  pendingEffects: [] as Array<() => void>,
  dirty: false,
}));

vi.mock("preact/hooks", () => ({
  useState: <T>(initial: T | (() => T)) => {
    const i = renderer.index++;
    if (!(i in renderer.slots)) {
      renderer.slots[i] =
        typeof initial === "function" ? (initial as () => T)() : initial;
    }
    const setState = (value: T) => {
      renderer.slots[i] = value;
      renderer.dirty = true;
    };
    return [renderer.slots[i], setState];
  },
  useRef: <T>(initial: T) => {
    const i = renderer.index++;
    if (!(i in renderer.slots)) renderer.slots[i] = { current: initial };
    return renderer.slots[i];
  },
  useCallback: <T>(fn: T) => {
    renderer.index++;
    return fn;
  },
  useLayoutEffect: (fn: () => void, deps: readonly unknown[]) => {
    const i = renderer.index++;
    const prev = renderer.slots[i] as readonly unknown[] | undefined;
    if (!prev || deps.some((dep, k) => dep !== prev[k])) {
      renderer.slots[i] = deps;
      renderer.pendingEffects.push(fn);
    }
  },
}));

const { useFileTreeState } = await import("./use-file-tree-state.js");
type FileTreeState = ReturnType<typeof useFileTreeState>;

function renderOnce(projectId: string, currentPath: string): FileTreeState {
  renderer.index = 0;
  renderer.pendingEffects = [];
  return useFileTreeState(projectId, currentPath);
}

function runEffects(): void {
  for (const effect of renderer.pendingEffects) effect();
  renderer.pendingEffects = [];
}

/** Render, run layout effects and re-render until the state settles. */
function render(projectId: string, currentPath: string): FileTreeState {
  renderer.dirty = false;
  let result = renderOnce(projectId, currentPath);
  runEffects();
  for (let i = 0; renderer.dirty && i < 10; i++) {
    renderer.dirty = false;
    result = renderOnce(projectId, currentPath);
    runEffects();
  }
  return result;
}

function createMemoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => Array.from(items.keys())[index] ?? null,
    removeItem: (key) => {
      items.delete(key);
    },
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
}

function seedStore(store: unknown): void {
  localStorage.setItem(FILE_TREE_STATE_KEY, JSON.stringify(store));
}

function readStore(): FileTreeStateStore {
  return JSON.parse(localStorage.getItem(FILE_TREE_STATE_KEY) ?? "{}");
}

const NOW = 1_000_000_000_000;

beforeEach(() => {
  renderer.slots = [];
  renderer.index = 0;
  renderer.pendingEffects = [];
  renderer.dirty = false;
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useFileTreeState", () => {
  it("opens only the ancestors of the current file on the first render, ignoring the stored state", () => {
    seedStore({ p: { expanded: ["z"], lastAccess: NOW } });
    const first = renderOnce("p", "a/b/c.md");

    expect(first.isOpen("a")).toBe(true);
    expect(first.isOpen("a/b")).toBe(true);
    expect(first.isOpen("z")).toBe(false);
  });

  it("restores the stored expanded directories after mount, keeping the ancestors open", () => {
    seedStore({ p: { expanded: ["z"], lastAccess: NOW - 1 } });
    const tree = render("p", "a/b/c.md");

    expect(tree.isOpen("z")).toBe(true);
    expect(tree.isOpen("a")).toBe(true);
    expect(tree.isOpen("a/b")).toBe(true);
    expect(tree.isOpen("m")).toBe(false);
  });

  it("rewrites the store on mount with expired and legacy entries dropped and lastAccess refreshed", () => {
    seedStore({
      p: { expanded: ["z"], lastAccess: NOW - 1 },
      stale: { expanded: ["x"], lastAccess: NOW - TTL_MS - 1 },
      legacy: { collapsed: ["y"], lastAccess: NOW },
    });
    render("p", "root.md");

    expect(readStore()).toEqual({ p: { expanded: ["z"], lastAccess: NOW } });
  });

  it("creates an empty entry on mount when nothing is stored", () => {
    render("p", "a/b/c.md");

    expect(readStore()).toEqual({ p: { expanded: [], lastAccess: NOW } });
  });

  it("persists only user-expanded directories when toggling open", () => {
    const tree = render("p", "a/b/c.md");
    vi.setSystemTime(NOW + 5);
    tree.toggle("a/sibling");

    expect(render("p", "a/b/c.md").isOpen("a/sibling")).toBe(true);
    expect(readStore()).toEqual({
      p: { expanded: ["a", "a/sibling"], lastAccess: NOW + 5 },
    });
  });

  it("closes a revealed ancestor without persisting it", () => {
    const tree = render("p", "a/b/c.md");
    tree.toggle("a/b");

    expect(render("p", "a/b/c.md").isOpen("a/b")).toBe(false);
    expect(readStore().p?.expanded).toEqual([]);
  });

  it("removes a closed directory from the store", () => {
    seedStore({ p: { expanded: ["z", "m"], lastAccess: NOW } });
    render("p", "root.md").toggle("z");

    expect(render("p", "root.md").isOpen("z")).toBe(false);
    expect(readStore().p?.expanded).toEqual(["m"]);
  });

  it("keeps entries written by other tabs when toggling", () => {
    const tree = render("p", "root.md");
    seedStore({ ...readStore(), other: { expanded: ["o"], lastAccess: NOW } });
    tree.toggle("z");

    expect(readStore().other).toEqual({ expanded: ["o"], lastAccess: NOW });
  });

  it("reveals the ancestors of a new current file without persisting them", () => {
    render("p", "root.md");
    const tree = render("p", "x/y/z.md");

    expect(tree.isOpen("x")).toBe(true);
    expect(tree.isOpen("x/y")).toBe(true);
    expect(readStore().p?.expanded).toEqual([]);
  });

  it("keeps a closed ancestor closed while the current file does not change", () => {
    render("p", "a/b/c.md").toggle("a");

    expect(render("p", "a/b/c.md").isOpen("a")).toBe(false);
  });

  it("reopens a closed ancestor when moving to another file in it", () => {
    render("p", "a/b/c.md").toggle("a");

    expect(render("p", "a/b/d.md").isOpen("a")).toBe(true);
  });

  it("keeps working in memory when localStorage throws", () => {
    const throwing = createMemoryStorage();
    throwing.getItem = () => {
      throw new Error("denied");
    };
    throwing.setItem = () => {
      throw new Error("denied");
    };
    vi.stubGlobal("localStorage", throwing);

    const tree = render("p", "root.md");
    expect(tree.isOpen("z")).toBe(false);
    tree.toggle("z");
    expect(render("p", "root.md").isOpen("z")).toBe(true);
  });
});
