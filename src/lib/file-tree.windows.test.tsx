import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import renderToString from "preact-render-to-string";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../components/navigation/sidebar.js";
import type { FileTreeNode } from "../core/file-tree.js";
import {
  initialOpenState,
  isDirectoryOpen,
} from "../core/file-tree-open-state.js";
import { assertOk } from "../test-utils/assert-result.js";
import { buildFileTree } from "./file-tree.js";

// Windows path conventions on top of the host file system: `sep` is `\` and
// `path.relative` joins its segments with `\`, as `path.win32` does.
vi.mock("node:path", async () => {
  const actual = await vi.importActual<typeof import("node:path")>("node:path");
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
    ] satisfies FileTreeNode[]);
  });

  it("highlights the file and opens its ancestors for a / path from a link", async () => {
    const tree = assertOk(await buildFileTree(testDir));
    const currentPath = "a/b/c.md";
    const openState = initialOpenState(tree, currentPath);
    const html = renderToString(
      <Sidebar
        title="docs"
        tree={tree}
        currentPath={currentPath}
        isOpen={(path) => isDirectoryOpen(openState, path)}
      />,
    );

    const expanded = [
      ...html.matchAll(
        /<button[^>]*aria-expanded="(true|false)"[\s\S]*?<span[^>]*>([^<]*)<\/span>/g,
      ),
    ].map(([, state, name]) => [name, state === "true"]);
    expect(Object.fromEntries(expanded)).toEqual({
      a: true,
      b: true,
      sibling: false,
    });

    const link = html.match(
      /<a href="\/view\?path=a%2Fb%2Fc\.md" class="([^"]*)"/,
    );
    expect(link?.[1]).toContain("text-sidebar-primary");
  });
});
