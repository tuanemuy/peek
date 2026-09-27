import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createFileTreeCache } from "../../lib/file-tree-cache.js";
import { initMarkdown } from "../../lib/markdown.js";
import { resolveStyles } from "../../lib/styles.js";
import { createDirectoryRoutes } from "./directory.js";

// On Windows `\` is a separator, so `toSlashPath` rewrites it.
vi.mock("../../core/path.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/path.js")>();
  return {
    ...actual,
    toSlashPath: (osPath: string) => osPath.replaceAll("\\", "/"),
  };
});

const testDir = join(import.meta.dirname, "__test_fixture_view_redirect__");

beforeAll(async () => {
  mkdirSync(join(testDir, "docs"), { recursive: true });
  writeFileSync(join(testDir, "docs", "guide.md"), "# Guide");
  await initMarkdown();
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

async function createTestApp(): Promise<Hono> {
  const styles = await resolveStyles();
  if (!styles.ok) throw new Error("Failed to resolve styles");
  return createDirectoryRoutes(
    testDir,
    styles.value,
    createFileTreeCache(testDir),
  );
}

describe("GET /view with a path that toSlashPath rewrites", () => {
  it("redirects to the /-separated path", async () => {
    const app = await createTestApp();
    const res = await app.request("/view?path=docs%5Cguide.md");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/view?path=docs%2Fguide.md");
  });

  it("redirects before rejecting a path outside the directory", async () => {
    const app = await createTestApp();
    const res = await app.request("/view?path=..%2Fdocs%5Csecret.md");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "/view?path=..%2Fdocs%2Fsecret.md",
    );
  });

  it("redirects before rejecting an unsupported file type", async () => {
    const app = await createTestApp();
    const res = await app.request("/view?path=docs%5Cnotes.txt");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/view?path=docs%2Fnotes.txt");
  });

  it("renders a path that toSlashPath leaves unchanged", async () => {
    const app = await createTestApp();
    const res = await app.request("/view?path=docs%2Fguide.md");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Guide");
  });
});
