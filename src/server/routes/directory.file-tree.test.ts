import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFileTreeCache } from "../../lib/file-tree-cache.js";
import { initMarkdown } from "../../lib/markdown.js";
import { resolveStyles } from "../../lib/styles.js";
import { createDirectoryRoutes } from "./directory.js";

const testDir = join(import.meta.dirname, "__test_fixture_file_tree__");

// a/
//   b/c.md
//   sibling/s.md
// z/z.md
// root.md
beforeAll(async () => {
  mkdirSync(join(testDir, "a", "b"), { recursive: true });
  mkdirSync(join(testDir, "a", "sibling"), { recursive: true });
  mkdirSync(join(testDir, "z"), { recursive: true });
  writeFileSync(join(testDir, "a", "b", "c.md"), "# C");
  writeFileSync(join(testDir, "a", "sibling", "s.md"), "# S");
  writeFileSync(join(testDir, "z", "z.md"), "# Z");
  writeFileSync(join(testDir, "root.md"), "# Root");
  await initMarkdown();
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

async function fetchSidebar(url: string): Promise<string> {
  const styles = await resolveStyles();
  if (!styles.ok) throw new Error("Failed to resolve styles");
  const app: Hono = createDirectoryRoutes(
    testDir,
    styles.value,
    createFileTreeCache(testDir),
  );
  const res = await app.request(url);
  expect(res.status).toBe(200);
  const html = await res.text();
  // Only the sidebar markup: __INITIAL_STATE__ also contains every path.
  const sidebar = html.match(/<aside id="sidebar"[\s\S]*?<\/aside>/)?.[0];
  if (!sidebar) throw new Error("Sidebar not found in SSR markup");
  return sidebar;
}

/** Directory name → aria-expanded, for every directory button rendered. */
function directoryStates(sidebar: string): Record<string, boolean> {
  const states: Record<string, boolean> = {};
  for (const [, expanded, name] of sidebar.matchAll(
    /<button[^>]*aria-expanded="(true|false)"[\s\S]*?<span[^>]*>([^<]*)<\/span>/g,
  )) {
    if (name !== undefined) states[name] = expanded === "true";
  }
  return states;
}

describe("directory routes - SSR file tree open state", () => {
  it("expands only the ancestors of the displayed nested file", async () => {
    const sidebar = await fetchSidebar("/view?path=a/b/c.md");
    expect(directoryStates(sidebar)).toEqual({
      a: true,
      b: true,
      sibling: false,
      z: false,
    });
    expect(sidebar).toContain(
      `href="/view?path=${encodeURIComponent("a/b/c.md")}"`,
    );
    expect(sidebar).not.toContain(
      `href="/view?path=${encodeURIComponent("a/sibling/s.md")}"`,
    );
    expect(sidebar).not.toContain(
      `href="/view?path=${encodeURIComponent("z/z.md")}"`,
    );
  });

  it("expands only the direct parent for a file one level deep", async () => {
    const sidebar = await fetchSidebar("/view?path=z/z.md");
    expect(directoryStates(sidebar)).toEqual({ a: false, z: true });
  });

  it("collapses every directory when the displayed file is at the root", async () => {
    const sidebar = await fetchSidebar("/view?path=root.md");
    expect(directoryStates(sidebar)).toEqual({ a: false, z: false });
    expect(sidebar).toContain(`href="/view?path=root.md"`);
  });

  it("expands the ancestors of the first file shown at /", async () => {
    const sidebar = await fetchSidebar("/");
    expect(directoryStates(sidebar)).toEqual({
      a: true,
      b: true,
      sibling: false,
      z: false,
    });
  });
});
