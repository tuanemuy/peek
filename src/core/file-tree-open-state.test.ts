import { describe, expect, it } from "vitest";
import type { FileTreeNode } from "./file-tree.js";
import {
  type FileTreeOpenState,
  initialOpenState,
  isDirectoryOpen,
  revealFile,
  toggleDirectory,
} from "./file-tree-open-state.js";

function dir(path: string, children: readonly FileTreeNode[]): FileTreeNode {
  return { name: path, path, type: "directory", children };
}

function file(path: string): FileTreeNode {
  return { name: path, path, type: "file" };
}

// a/
//   b/
//     c/d.md
//     e.md
//   d.md
//   sibling/s.md
// ab/c.md
// d.md
const tree: readonly FileTreeNode[] = [
  dir("a", [
    dir("a/b", [dir("a/b/c", [file("a/b/c/d.md")]), file("a/b/e.md")]),
    dir("a/sibling", [file("a/sibling/s.md")]),
    file("a/d.md"),
  ]),
  dir("ab", [file("ab/c.md")]),
  file("d.md"),
];

function state(
  expanded: readonly string[],
  revealed: readonly string[],
): FileTreeOpenState {
  return { expanded: new Set(expanded), revealed: new Set(revealed) };
}

describe("initialOpenState", () => {
  it("reveals every ancestor of a nested file", () => {
    expect(initialOpenState(tree, "a/b/c/d.md")).toEqual(
      state([], ["a", "a/b", "a/b/c"]),
    );
  });

  it("reveals the single parent of a file one level deep", () => {
    expect(initialOpenState(tree, "a/d.md")).toEqual(state([], ["a"]));
  });

  it("reveals nothing for a file at the root", () => {
    expect(initialOpenState(tree, "d.md")).toEqual(state([], []));
  });

  it("reveals the directories of a file excluded from the tree", () => {
    expect(initialOpenState(tree, "a/b/ignored.md")).toEqual(
      state([], ["a", "a/b"]),
    );
  });

  it("does not open a directory whose name is a prefix of an ancestor", () => {
    const initial = initialOpenState(tree, "ab/c.md");
    expect(isDirectoryOpen(initial, "ab")).toBe(true);
    expect(isDirectoryOpen(initial, "a")).toBe(false);
  });
});

describe("isDirectoryOpen", () => {
  it("is open when the path is only user-expanded", () => {
    expect(isDirectoryOpen(state(["a"], []), "a")).toBe(true);
  });

  it("is open when the path is only revealed", () => {
    expect(isDirectoryOpen(state([], ["a"]), "a")).toBe(true);
  });

  it("is closed when the path is in neither set", () => {
    expect(isDirectoryOpen(state(["a"], ["b"]), "c")).toBe(false);
  });
});

describe("toggleDirectory", () => {
  it("opens a closed top-level directory as user-expanded", () => {
    expect(toggleDirectory(state([], []), tree, "a")).toEqual(state(["a"], []));
  });

  it("marks the ancestors of an opened directory as user-expanded", () => {
    expect(toggleDirectory(state([], ["a", "a/b"]), tree, "a/b/c")).toEqual(
      state(["a", "a/b", "a/b/c"], ["a", "a/b"]),
    );
  });

  it("closes a user-expanded directory", () => {
    expect(toggleDirectory(state(["a", "ab"], []), tree, "a")).toEqual(
      state(["ab"], []),
    );
  });

  it("closes a revealed directory", () => {
    expect(toggleDirectory(state([], ["a", "a/b"]), tree, "a/b")).toEqual(
      state([], ["a"]),
    );
  });

  it("closes a directory that is both user-expanded and revealed", () => {
    const closed = toggleDirectory(state(["a"], ["a"]), tree, "a");
    expect(isDirectoryOpen(closed, "a")).toBe(false);
  });

  it("keeps descendants user-expanded when closing a directory", () => {
    const closed = toggleDirectory(state(["a", "a/b"], []), tree, "a");
    expect(closed).toEqual(state(["a/b"], []));
    expect(toggleDirectory(closed, tree, "a")).toEqual(state(["a/b", "a"], []));
  });

  it("does not mutate the input state", () => {
    const input = state(["a"], ["ab"]);
    toggleDirectory(input, tree, "a");
    toggleDirectory(input, tree, "a/b");
    expect(input).toEqual(state(["a"], ["ab"]));
  });
});

describe("revealFile", () => {
  it("adds the ancestors of the file to revealed only", () => {
    expect(revealFile(state(["ab"], ["x"]), tree, "a/b/e.md")).toEqual(
      state(["ab"], ["x", "a", "a/b"]),
    );
  });

  it("reopens a revealed ancestor the user had closed", () => {
    const closed = toggleDirectory(state([], ["a"]), tree, "a");
    expect(isDirectoryOpen(revealFile(closed, tree, "a/d.md"), "a")).toBe(true);
  });

  it("changes nothing for a file at the root", () => {
    expect(revealFile(state(["ab"], ["x"]), tree, "d.md")).toEqual(
      state(["ab"], ["x"]),
    );
  });

  it("does not mutate the input state", () => {
    const input = state([], []);
    revealFile(input, tree, "a/d.md");
    expect(input).toEqual(state([], []));
  });
});
