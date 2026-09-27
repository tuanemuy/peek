import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import renderToString from "preact-render-to-string";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../components/navigation/sidebar.js";
import type { FileTreeNode } from "../core/file-tree.js";
import {
  type FileTreeOpenState,
  initialOpenState,
  isDirectoryOpen,
  revealFile,
} from "../core/file-tree-open-state.js";
import { assertOk } from "../test-utils/assert-result.js";
import { buildFileTree } from "./file-tree.js";

// Windows path conventions on top of the host file system: `sep` is `\` and
// `path.relative` joins its segments with `\`, as `path.win32` does.
vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return {
    ...actual,
    sep: "\\",
    relative: (from: string, to: string) =>
      actual.relative(from, to).split(actual.sep).join("\\"),
  };
});

const testDir = join(import.meta.dirname, "__test_fixture_windows__");

// a/
//   b/c.md
//   sibling/s.md
// root.md
beforeAll(() => {
  mkdirSync(join(testDir, "a", "b"), { recursive: true });
  mkdirSync(join(testDir, "a", "sibling"), { recursive: true });
  writeFileSync(join(testDir, "a", "b", "c.md"), "# C");
  writeFileSync(join(testDir, "a", "sibling", "s.md"), "# S");
  writeFileSync(join(testDir, "root.md"), "# Root");
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

/** Directory name → open, and the hrefs of the highlighted file links. */
function renderSidebar(
  tree: readonly FileTreeNode[],
  currentPath: string,
  state: FileTreeOpenState,
): { readonly open: Record<string, boolean>; readonly active: string[] } {
  const html = renderToString(
    <Sidebar
      title="docs"
      tree={tree}
      currentPath={currentPath}
      isOpen={(path) => isDirectoryOpen(state, path)}
    />,
  );
  const open = Object.fromEntries(
    [
      ...html.matchAll(
        /<button[^>]*aria-expanded="(true|false)"[\s\S]*?<span[^>]*>([^<]*)<\/span>/g,
      ),
    ].map(([, expanded, name]) => [name, expanded === "true"]),
  );
  const active = [
    ...html.matchAll(
      /<a href="(\/view\?path=[^"]*)" class="[^"]*text-sidebar-primary/g,
    ),
  ].map(([, href]) => decodeURIComponent(href ?? ""));
  return { open, active };
}

describe("buildFileTree with Windows paths", () => {
  it("separates every node path with /", async () => {
    const tree = assertOk(await buildFileTree(testDir));
    expect(tree).toEqual([
      {
        name: "a",
        path: "a",
        type: "directory",
        children: [
          {
            name: "b",
            path: "a/b",
            type: "directory",
            children: [{ name: "c.md", path: "a/b/c.md", type: "file" }],
          },
          {
            name: "sibling",
            path: "a/sibling",
            type: "directory",
            children: [{ name: "s.md", path: "a/sibling/s.md", type: "file" }],
          },
        ],
      },
      { name: "root.md", path: "root.md", type: "file" },
    ]);
  });

  it("highlights the file and opens its ancestors when a / path is rendered first", async () => {
    const tree = assertOk(await buildFileTree(testDir));
    const sidebar = renderSidebar(
      tree,
      "a/b/c.md",
      initialOpenState(tree, "a/b/c.md"),
    );
    expect(sidebar.open).toEqual({ a: true, b: true, sibling: false });
    expect(sidebar.active).toEqual(["/view?path=a/b/c.md"]);
  });

  it("highlights the file and opens its ancestors after navigating to a / path", async () => {
    const tree = assertOk(await buildFileTree(testDir));
    const before = initialOpenState(tree, "root.md");
    expect(renderSidebar(tree, "root.md", before).open).toEqual({ a: false });

    const sidebar = renderSidebar(
      tree,
      "a/b/c.md",
      revealFile(before, tree, "a/b/c.md"),
    );
    expect(sidebar.open).toEqual({ a: true, b: true, sibling: false });
    expect(sidebar.active).toEqual(["/view?path=a/b/c.md"]);
  });
});
