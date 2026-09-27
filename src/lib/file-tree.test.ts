import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertErr, assertOk } from "../test-utils/assert-result.js";
import { buildFileTree } from "./file-tree.js";

const testDir = join(import.meta.dirname, "__test_fixture__");

beforeAll(() => {
  mkdirSync(testDir, { recursive: true });
  mkdirSync(join(testDir, "docs"), { recursive: true });
  mkdirSync(join(testDir, "guides"), { recursive: true });
  mkdirSync(join(testDir, ".git"), { recursive: true });
  mkdirSync(join(testDir, "node_modules"), { recursive: true });
  mkdirSync(join(testDir, "empty-dir"), { recursive: true });

  writeFileSync(join(testDir, "README.md"), "# README");
  writeFileSync(join(testDir, "docs", "overview.md"), "# Overview");
  writeFileSync(join(testDir, "docs", "setup.md"), "# Setup");
  writeFileSync(join(testDir, "guides", "intro.md"), "# Intro");
  writeFileSync(join(testDir, "page.html"), "<h1>Page</h1>");
  writeFileSync(join(testDir, "notes.txt"), "not markdown");
  writeFileSync(join(testDir, ".git", "config"), "git config");
  writeFileSync(join(testDir, "node_modules", "pkg.md"), "# pkg");
  writeFileSync(join(testDir, ".hidden.md"), "# Hidden");
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("buildFileTree", () => {
  it("builds a tree with directories and files", async () => {
    const result = await buildFileTree(testDir);
    const tree = assertOk(result);
    expect(tree.length).toBeGreaterThan(0);

    const dirs = tree.filter((n) => n.type === "directory");
    const files = tree.filter((n) => n.type === "file");

    expect(dirs.some((d) => d.name === "docs")).toBe(true);
    expect(dirs.some((d) => d.name === "guides")).toBe(true);
    expect(files.some((f) => f.name === "README.md")).toBe(true);
  });

  it("excludes .git", async () => {
    const result = await buildFileTree(testDir);
    const tree = assertOk(result);
    const allNames = flattenNames(tree);

    expect(allNames).not.toContain(".git");
  });

  it("only includes supported files (.md, .html, .htm)", async () => {
    const result = await buildFileTree(testDir);
    const tree = assertOk(result);
    const allFiles = flattenFiles(tree);

    for (const f of allFiles) {
      expect(f.name).toMatch(/\.(md|html|htm)$/);
    }
    expect(allFiles.some((f) => f.name === "notes.txt")).toBe(false);
  });

  it("sorts directories before files, alphabetically", async () => {
    const result = await buildFileTree(testDir);
    const tree = assertOk(result);
    const types = tree.map((n) => n.type);
    const lastDirIndex = types.lastIndexOf("directory");
    const firstFileIndex = types.indexOf("file");

    if (lastDirIndex >= 0 && firstFileIndex >= 0) {
      expect(lastDirIndex).toBeLessThan(firstFileIndex);
    }
  });

  it("includes dotfiles not excluded by ignore rules", async () => {
    const result = await buildFileTree(testDir);
    const tree = assertOk(result);
    const allNames = flattenNames(tree);
    expect(allNames).toContain(".hidden.md");
  });

  it("excludes empty directories", async () => {
    const result = await buildFileTree(testDir);
    const tree = assertOk(result);
    const allNames = flattenNames(tree);
    expect(allNames).not.toContain("empty-dir");
  });

  it("uses relative paths", async () => {
    const result = await buildFileTree(testDir);
    const tree = assertOk(result);
    const docsDir = tree.find((n) => n.name === "docs");
    expect(docsDir?.path).toBe("docs");

    if (docsDir?.children) {
      const overview = docsDir.children.find((n) => n.name === "overview.md");
      expect(overview?.path).toBe("docs/overview.md");
    }
  });
});

describe.skipIf(process.platform === "win32")(
  "buildFileTree with a backslash in a file name",
  () => {
    const dir = join(import.meta.dirname, "__test_fixture_backslash__");

    beforeAll(() => {
      mkdirSync(join(dir, "docs"), { recursive: true });
      writeFileSync(join(dir, "docs", "a\\b.md"), "# Backslash");
    });

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("keeps the backslash in the node path", async () => {
      const tree = assertOk(await buildFileTree(dir));
      expect(tree).toEqual([
        {
          name: "docs",
          path: "docs",
          type: "directory",
          children: [{ name: "a\\b.md", path: "docs/a\\b.md", type: "file" }],
        },
      ]);
    });
  },
);

describe("buildFileTree error handling", () => {
  it("returns root-not-accessible when the root directory does not exist", async () => {
    const result = await buildFileTree("/nonexistent/path");
    const error = assertErr(result);
    expect(error.type).toBe("root-not-accessible");
    expect(error.cause).toBeInstanceOf(Error);
  });
});

describe("buildFileTree with .gitignore", () => {
  const gitignoreDir = join(import.meta.dirname, "__test_gitignore__");

  beforeAll(() => {
    mkdirSync(gitignoreDir, { recursive: true });
    mkdirSync(join(gitignoreDir, "docs"), { recursive: true });
    mkdirSync(join(gitignoreDir, "vendor"), { recursive: true });
    mkdirSync(join(gitignoreDir, "output"), { recursive: true });

    writeFileSync(join(gitignoreDir, "README.md"), "# README");
    writeFileSync(join(gitignoreDir, "docs", "guide.md"), "# Guide");
    writeFileSync(join(gitignoreDir, "vendor", "lib.md"), "# Lib");
    writeFileSync(join(gitignoreDir, "output", "result.md"), "# Result");

    writeFileSync(join(gitignoreDir, ".gitignore"), "vendor/\noutput/\n");
  });

  afterAll(() => {
    rmSync(gitignoreDir, { recursive: true, force: true });
  });

  it("excludes directories listed in .gitignore", async () => {
    const result = await buildFileTree(gitignoreDir);
    const tree = assertOk(result);
    const allNames = flattenNames(tree);

    expect(allNames).not.toContain("vendor");
    expect(allNames).not.toContain("output");
  });

  it("includes directories not listed in .gitignore", async () => {
    const result = await buildFileTree(gitignoreDir);
    const tree = assertOk(result);
    const allNames = flattenNames(tree);

    expect(allNames).toContain("docs");
    expect(allNames).toContain("README.md");
  });
});

describe("buildFileTree with nested .gitignore", () => {
  const nestedDir = join(import.meta.dirname, "__test_nested_gitignore__");

  beforeAll(() => {
    mkdirSync(join(nestedDir, "docs", "drafts"), { recursive: true });
    mkdirSync(join(nestedDir, "docs", "published"), { recursive: true });
    mkdirSync(join(nestedDir, "src", "internal"), { recursive: true });
    mkdirSync(join(nestedDir, "src", "public"), { recursive: true });

    writeFileSync(join(nestedDir, "README.md"), "# README");
    writeFileSync(join(nestedDir, "docs", "guide.md"), "# Guide");
    writeFileSync(join(nestedDir, "docs", "drafts", "wip.md"), "# WIP");
    writeFileSync(
      join(nestedDir, "docs", "published", "stable.md"),
      "# Stable",
    );
    writeFileSync(join(nestedDir, "src", "internal", "secret.md"), "# Secret");
    writeFileSync(join(nestedDir, "src", "public", "api.md"), "# API");

    // Root .gitignore does not exclude docs/ or src/
    writeFileSync(join(nestedDir, ".gitignore"), "");
    // Nested .gitignore in docs/ excludes drafts/
    writeFileSync(join(nestedDir, "docs", ".gitignore"), "drafts/\n");
    // Nested .gitignore in src/ excludes internal/
    writeFileSync(join(nestedDir, "src", ".gitignore"), "internal/\n");
  });

  afterAll(() => {
    rmSync(nestedDir, { recursive: true, force: true });
  });

  it("excludes directories listed in nested .gitignore", async () => {
    const result = await buildFileTree(nestedDir);
    const tree = assertOk(result);
    const allNames = flattenNames(tree);

    expect(allNames).not.toContain("drafts");
    expect(allNames).not.toContain("wip.md");
    expect(allNames).not.toContain("internal");
    expect(allNames).not.toContain("secret.md");
  });

  it("includes directories not listed in nested .gitignore", async () => {
    const result = await buildFileTree(nestedDir);
    const tree = assertOk(result);
    const allNames = flattenNames(tree);

    expect(allNames).toContain("docs");
    expect(allNames).toContain("guide.md");
    expect(allNames).toContain("published");
    expect(allNames).toContain("stable.md");
    expect(allNames).toContain("src");
    expect(allNames).toContain("public");
    expect(allNames).toContain("api.md");
  });

  it("nested .gitignore does not affect sibling directories", async () => {
    const result = await buildFileTree(nestedDir);
    const tree = assertOk(result);
    const allNames = flattenNames(tree);

    // docs/.gitignore has "drafts/" but src/public should not be affected
    expect(allNames).toContain("public");
    expect(allNames).toContain("api.md");
  });
});

const isRoot = process.getuid?.() === 0;

describe.skipIf(isRoot)("buildFileTree with unreadable .gitignore", () => {
  const permDir = join(import.meta.dirname, "__test_gitignore_perm__");

  beforeAll(() => {
    mkdirSync(join(permDir, "docs"), { recursive: true });
    writeFileSync(join(permDir, "README.md"), "# README");
    writeFileSync(join(permDir, "docs", "guide.md"), "# Guide");
    writeFileSync(join(permDir, ".gitignore"), "some-pattern/\n");
    chmodSync(join(permDir, ".gitignore"), 0o000);
  });

  afterAll(() => {
    chmodSync(join(permDir, ".gitignore"), 0o644);
    rmSync(permDir, { recursive: true, force: true });
  });

  it("continues building the tree when .gitignore is unreadable", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await buildFileTree(permDir);
    const tree = assertOk(result);
    expect(tree.length).toBeGreaterThan(0);
    expect(tree.some((n) => n.name === "README.md")).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      "[peek]",
      expect.stringContaining("Failed to read .gitignore"),
      expect.anything(),
    );
    warnSpy.mockRestore();
  });
});

type TreeNode = {
  readonly name: string;
  readonly type: string;
  readonly children?: readonly TreeNode[];
};

function flattenNames(nodes: readonly TreeNode[]): string[] {
  const names: string[] = [];
  for (const node of nodes) {
    names.push(node.name);
    if (node.children) {
      names.push(...flattenNames(node.children));
    }
  }
  return names;
}

function flattenFiles(nodes: readonly TreeNode[]): TreeNode[] {
  const files: TreeNode[] = [];
  for (const node of nodes) {
    if (node.type === "file") {
      files.push(node);
    }
    if (node.children) {
      files.push(...flattenFiles(node.children));
    }
  }
  return files;
}
