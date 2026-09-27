import { describe, expect, it } from "vitest";
import {
  type FileTreeOpenState,
  initialOpenState,
  isDirectoryOpen,
  revealFile,
  toggleDirectory,
} from "./file-tree-open-state.js";

function state(
  expanded: readonly string[],
  revealed: readonly string[],
): FileTreeOpenState {
  return { expanded: new Set(expanded), revealed: new Set(revealed) };
}

describe("initialOpenState", () => {
  it("reveals every ancestor of a nested file, outermost first", () => {
    expect(initialOpenState("a/b/c/d.md")).toEqual(
      state([], ["a", "a/b", "a/b/c"]),
    );
  });

  it("reveals the single parent of a file one level deep", () => {
    expect(initialOpenState("a/d.md")).toEqual(state([], ["a"]));
  });

  it("reveals nothing for a file at the root", () => {
    expect(initialOpenState("d.md")).toEqual(state([], []));
  });

  it("reveals ancestors of a Windows-style path with its own separators", () => {
    expect(initialOpenState("a\\b\\c.md")).toEqual(state([], ["a", "a\\b"]));
  });

  it("does not treat a directory prefix of the name as an ancestor", () => {
    const initial = initialOpenState("ab/c.md");
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
    expect(toggleDirectory(state([], []), "a")).toEqual(state(["a"], []));
  });

  it("marks the ancestors of an opened directory as user-expanded", () => {
    expect(toggleDirectory(state([], ["a"]), "a/b")).toEqual(
      state(["a", "a/b"], ["a"]),
    );
  });

  it("marks the ancestors of an opened Windows-style directory", () => {
    expect(toggleDirectory(state([], ["a"]), "a\\b")).toEqual(
      state(["a", "a\\b"], ["a"]),
    );
  });

  it("closes a user-expanded directory", () => {
    expect(toggleDirectory(state(["a", "x"], []), "a")).toEqual(
      state(["x"], []),
    );
  });

  it("closes a revealed directory", () => {
    expect(toggleDirectory(state([], ["a", "a/b"]), "a/b")).toEqual(
      state([], ["a"]),
    );
  });

  it("closes a directory that is both user-expanded and revealed", () => {
    const closed = toggleDirectory(state(["a"], ["a"]), "a");
    expect(isDirectoryOpen(closed, "a")).toBe(false);
  });

  it("keeps descendants user-expanded when closing a directory", () => {
    const closed = toggleDirectory(state(["a", "a/b"], []), "a");
    expect(closed).toEqual(state(["a/b"], []));
    expect(toggleDirectory(closed, "a")).toEqual(state(["a/b", "a"], []));
  });

  it("does not mutate the input state", () => {
    const input = state(["a"], ["r"]);
    toggleDirectory(input, "a");
    toggleDirectory(input, "b");
    expect(input).toEqual(state(["a"], ["r"]));
  });
});

describe("revealFile", () => {
  it("adds the ancestors of the file to revealed only", () => {
    expect(revealFile(state(["x"], ["y"]), "a/b/c.md")).toEqual(
      state(["x"], ["y", "a", "a/b"]),
    );
  });

  it("reopens a revealed ancestor the user had closed", () => {
    const closed = toggleDirectory(state([], ["a"]), "a");
    expect(isDirectoryOpen(revealFile(closed, "a/other.md"), "a")).toBe(true);
  });

  it("changes nothing for a file at the root", () => {
    expect(revealFile(state(["x"], ["y"]), "d.md")).toEqual(
      state(["x"], ["y"]),
    );
  });

  it("does not mutate the input state", () => {
    const input = state([], []);
    revealFile(input, "a/b.md");
    expect(input).toEqual(state([], []));
  });
});
