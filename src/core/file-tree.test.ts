import { describe, expect, it } from "vitest";
import { type FileTreeNode, filterFileTree } from "./file-tree.js";

function file(name: string, path: string): FileTreeNode {
  return { name, path, type: "file" };
}

function dir(
  name: string,
  path: string,
  children: readonly FileTreeNode[],
): FileTreeNode {
  return { name, path, type: "directory", children };
}

// docs/
//   guide.md
//   api/
//     reference.md
//     overview.md
// README.md
function makeTree(): readonly FileTreeNode[] {
  return [
    dir("docs", "docs", [
      file("guide.md", "docs/guide.md"),
      dir("api", "docs/api", [
        file("reference.md", "docs/api/reference.md"),
        file("overview.md", "docs/api/overview.md"),
      ]),
    ]),
    file("README.md", "README.md"),
  ];
}

describe("filterFileTree", () => {
  it("returns the input unchanged for an empty query", () => {
    const tree = makeTree();
    expect(filterFileTree(tree, "")).toBe(tree);
  });

  it("returns the input unchanged for a whitespace-only query", () => {
    const tree = makeTree();
    expect(filterFileTree(tree, "   ")).toBe(tree);
  });

  it("matches case-insensitively", () => {
    const result = filterFileTree(makeTree(), "README");
    expect(result).toHaveLength(1);
    expect(result[0]?.path).toBe("README.md");
  });

  it("matches a file name by substring", () => {
    const result = filterFileTree(makeTree(), "guide");
    // Only the docs/ ancestor with the matched file remains.
    expect(result).toHaveLength(1);
    const docs = result[0];
    expect(docs?.path).toBe("docs");
    expect(docs?.children).toHaveLength(1);
    expect(docs?.children?.[0]?.path).toBe("docs/guide.md");
  });

  it("keeps the whole subtree when a directory name matches (case A)", () => {
    const tree = makeTree();
    const result = filterFileTree(tree, "api");
    expect(result).toHaveLength(1);
    const docs = result[0];
    expect(docs?.path).toBe("docs");
    const api = docs?.children?.[0];
    expect(api?.path).toBe("docs/api");
    // Both children of the matched directory are preserved.
    expect(api?.children).toHaveLength(2);
    expect(api?.children?.map((n) => n.path)).toEqual([
      "docs/api/reference.md",
      "docs/api/overview.md",
    ]);
    // Case A shares the matched directory node by reference (no copy).
    expect(result[0]?.children?.[0]).toBe(tree[0]?.children?.[1]);
  });

  it("keeps the ancestor path when a grandchild matches", () => {
    const result = filterFileTree(makeTree(), "reference");
    expect(result).toHaveLength(1);
    const docs = result[0];
    expect(docs?.path).toBe("docs");
    // guide.md is filtered out; only the api subtree path remains.
    expect(docs?.children).toHaveLength(1);
    const api = docs?.children?.[0];
    expect(api?.path).toBe("docs/api");
    expect(api?.children).toHaveLength(1);
    expect(api?.children?.[0]?.path).toBe("docs/api/reference.md");
  });

  it("drops a sibling directory whose descendants do not match", () => {
    // kept/ contains a matching file; dropped/ contains none → only kept/ remains.
    const fixture: readonly FileTreeNode[] = [
      dir("kept", "kept", [file("target.md", "kept/target.md")]),
      dir("dropped", "dropped", [file("other.md", "dropped/other.md")]),
    ];
    const result = filterFileTree(fixture, "target");
    expect(result.map((n) => n.path)).toEqual(["kept"]);
    expect(result.some((n) => n.path === "dropped")).toBe(false);
  });

  it("returns an empty array when nothing matches", () => {
    expect(filterFileTree(makeTree(), "nonexistent")).toEqual([]);
  });

  it("does not mutate the input array or nodes", () => {
    const tree = makeTree();
    const snapshot = structuredClone(tree);
    filterFileTree(tree, "reference");
    expect(tree).toEqual(snapshot);
  });

  it("preserves the original ordering", () => {
    const result = filterFileTree(makeTree(), "md");
    // Top-level order: docs/ before README.md.
    expect(result.map((n) => n.path)).toEqual(["docs", "README.md"]);
    const docs = result[0];
    // Within docs/: guide.md before api/.
    expect(docs?.children?.map((n) => n.path)).toEqual([
      "docs/guide.md",
      "docs/api",
    ]);
  });
});
