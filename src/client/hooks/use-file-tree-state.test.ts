import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileTreeNode } from "../../core/file-tree.js";
import type { SlashPath } from "../../core/slash-path.js";
import { slash } from "../../test-utils/slash-path.js";
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

function dir(path: string, children: readonly FileTreeNode[]): FileTreeNode {
  return { name: path, path: slash(path), type: "directory", children };
}

function file(path: string): FileTreeNode {
  return { name: path, path: slash(path), type: "file" };
}

const tree: readonly FileTreeNode[] = [
  dir("a", [
    dir("a/b", [file("a/b/c.md"), file("a/b/d.md")]),
    dir("a/sibling", [file("a/sibling/s.md")]),
  ]),
  dir("m", [file("m/m.md")]),
  dir("x", [dir("x/y", [file("x/y/z.md")])]),
  dir("z", [file("z/z.md")]),
  file("root.md"),
];

function renderOnce(projectId: string, initialPath: SlashPath): FileTreeState {
  renderer.index = 0;
  renderer.pendingEffects = [];
  return useFileTreeState(projectId, tree, initialPath);
}

function runEffects(): void {
  for (const effect of renderer.pendingEffects) effect();
  renderer.pendingEffects = [];
}

/** Render, run layout effects and re-render until the state settles. */
function render(projectId: string, initialPath: SlashPath): FileTreeState {
  renderer.dirty = false;
  let result = renderOnce(projectId, initialPath);
  runEffects();
  for (let i = 0; renderer.dirty && i < 10; i++) {
    renderer.dirty = false;
    result = renderOnce(projectId, initialPath);
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
    const first = renderOnce("p", slash("a/b/c.md"));

    expect(first.isOpen(slash("a"))).toBe(true);
    expect(first.isOpen(slash("a/b"))).toBe(true);
    expect(first.isOpen(slash("z"))).toBe(false);
  });

  it("restores the stored expanded directories after mount, keeping the ancestors open", () => {
    seedStore({ p: { expanded: ["z"], lastAccess: NOW - 1 } });
    const fileTree = render("p", slash("a/b/c.md"));

    expect(fileTree.isOpen(slash("z"))).toBe(true);
    expect(fileTree.isOpen(slash("a"))).toBe(true);
    expect(fileTree.isOpen(slash("a/b"))).toBe(true);
    expect(fileTree.isOpen(slash("m"))).toBe(false);
  });

  it("rewrites the store on mount with expired and legacy entries dropped and lastAccess refreshed", () => {
    seedStore({
      p: { expanded: ["z"], lastAccess: NOW - 1 },
      stale: { expanded: ["x"], lastAccess: NOW - TTL_MS - 1 },
      legacy: { collapsed: ["y"], lastAccess: NOW },
    });
    render("p", slash("root.md"));

    expect(readStore()).toEqual({ p: { expanded: ["z"], lastAccess: NOW } });
  });

  it("creates an empty entry on mount when nothing is stored", () => {
    render("p", slash("a/b/c.md"));

    expect(readStore()).toEqual({ p: { expanded: [], lastAccess: NOW } });
  });

  it("persists only user-expanded directories when toggling open", () => {
    const fileTree = render("p", slash("a/b/c.md"));
    vi.setSystemTime(NOW + 5);
    fileTree.toggle(slash("a/sibling"));

    expect(render("p", slash("a/b/c.md")).isOpen(slash("a/sibling"))).toBe(
      true,
    );
    expect(readStore()).toEqual({
      p: { expanded: ["a", "a/sibling"], lastAccess: NOW + 5 },
    });
  });

  it("closes a revealed ancestor without persisting it", () => {
    const fileTree = render("p", slash("a/b/c.md"));
    fileTree.toggle(slash("a/b"));

    expect(render("p", slash("a/b/c.md")).isOpen(slash("a/b"))).toBe(false);
    expect(readStore().p?.expanded).toEqual([]);
  });

  it("removes a closed directory from the store", () => {
    seedStore({ p: { expanded: ["z", "m"], lastAccess: NOW } });
    render("p", slash("root.md")).toggle(slash("z"));

    expect(render("p", slash("root.md")).isOpen(slash("z"))).toBe(false);
    expect(readStore().p?.expanded).toEqual(["m"]);
  });

  it("keeps entries written by other tabs when toggling", () => {
    const fileTree = render("p", slash("root.md"));
    seedStore({ ...readStore(), other: { expanded: ["o"], lastAccess: NOW } });
    fileTree.toggle(slash("z"));

    expect(readStore().other).toEqual({ expanded: ["o"], lastAccess: NOW });
  });

  it("reveals the ancestors of a file without persisting them", () => {
    render("p", slash("root.md")).reveal(slash("x/y/z.md"));
    const fileTree = render("p", slash("root.md"));

    expect(fileTree.isOpen(slash("x"))).toBe(true);
    expect(fileTree.isOpen(slash("x/y"))).toBe(true);
    expect(fileTree.isOpen(slash("z"))).toBe(false);
    expect(readStore().p?.expanded).toEqual([]);
  });

  it("keeps a closed ancestor closed across re-renders without a reveal", () => {
    render("p", slash("a/b/c.md")).toggle(slash("a"));

    expect(render("p", slash("a/b/c.md")).isOpen(slash("a"))).toBe(false);
  });

  it("reopens a closed ancestor when the same file is revealed again", () => {
    render("p", slash("a/b/c.md")).toggle(slash("a"));
    render("p", slash("a/b/c.md")).reveal(slash("a/b/c.md"));

    expect(render("p", slash("a/b/c.md")).isOpen(slash("a"))).toBe(true);
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

    const fileTree = render("p", slash("root.md"));
    expect(fileTree.isOpen(slash("z"))).toBe(false);
    fileTree.toggle(slash("z"));
    expect(render("p", slash("root.md")).isOpen(slash("z"))).toBe(true);
  });
});
