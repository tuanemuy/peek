import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFileTreeCache } from "../../lib/file-tree-cache.js";
import { initMarkdown } from "../../lib/markdown.js";
import { resolveStyles } from "../../lib/styles.js";
import { createDirectoryRoutes } from "./directory.js";

const testDir = join(import.meta.dirname, "__test_fixture_dir__");

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  mkdirSync(join(testDir, "docs"), { recursive: true });
  writeFileSync(join(testDir, "README.md"), "# README\n\nHello");
  writeFileSync(
    join(testDir, "docs", "guide.md"),
    "# Guide\n\nContent\n\n![up](../img.png)",
  );
  mkdirSync(join(testDir, "raw"), { recursive: true });
  writeFileSync(join(testDir, "raw", "note.md"), "# Raw Note");
  mkdirSync(join(testDir, "my docs"), { recursive: true });
  writeFileSync(join(testDir, "my docs", "a page.html"), "<h1>Nested</h1>");
  writeFileSync(
    join(testDir, "page.html"),
    "<h1>HTML Page</h1><p>Hello HTML</p>",
  );
  await initMarkdown();
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

async function createTestApp(): Promise<Hono> {
  const result = await resolveStyles();
  if (!result.ok) throw new Error("Failed to resolve styles");
  const treeCache = createFileTreeCache(testDir);
  return createDirectoryRoutes(testDir, result.value, treeCache);
}

describe("directory routes", () => {
  it("GET / returns file tree listing page", async () => {
    const app = await createTestApp();
    const res = await app.request("/");
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("README.md");
    expect(html).toContain("docs");
  });

  it("GET /view?path=README.md returns sidebar + preview", async () => {
    const app = await createTestApp();
    const res = await app.request("/view?path=README.md");
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("README.md");
    expect(html).toContain("sidebar");
    expect(html).toContain("Hello");
  });

  it("GET /view?path=docs/guide.md works with nested paths", async () => {
    const app = await createTestApp();
    const res = await app.request("/view?path=docs/guide.md");
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain("Guide");
    expect(html).toContain("Content");
  });

  it("GET /view without path redirects to /", async () => {
    const app = await createTestApp();
    const res = await app.request("/view");
    expect(res.status).toBe(302);
  });

  it("GET /view?path=nonexistent.md returns 404", async () => {
    const app = await createTestApp();
    const res = await app.request("/view?path=nonexistent.md");
    expect(res.status).toBe(404);
  });

  it("GET /view with path traversal returns 403", async () => {
    const app = await createTestApp();
    const res = await app.request("/view?path=../../../etc/passwd");
    expect(res.status).toBe(403);
  });
});

describe("directory routes - catch-all path", () => {
  it("GET /README.md returns rendered file preview", async () => {
    const app = await createTestApp();
    const res = await app.request("/README.md");
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("README.md");
    expect(html).toContain("Hello");
  });

  it("GET /docs/guide.md works with nested paths", async () => {
    const app = await createTestApp();
    const res = await app.request("/docs/guide.md");
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain("Guide");
    expect(html).toContain("Content");
  });

  it("GET /nonexistent.md returns 404", async () => {
    const app = await createTestApp();
    const res = await app.request("/nonexistent.md");
    expect(res.status).toBe(404);
  });

  it("GET /page.html returns standalone HTML document with iframe and SSE", async () => {
    const app = await createTestApp();
    const res = await app.request("/page.html");
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("iframe");
    expect(html).toContain('src="/__peek/raw/page.html"');
    // Standalone HTML document (no Preact hydration) with inline SSE
    expect(html).toContain("EventSource");
    expect(html).toContain("page.html - peek");
    // Should NOT contain Preact initial state (no hydration mismatch)
    expect(html).not.toContain("__INITIAL_STATE__");
  });

  it("GET /somefile.txt returns 404 for unsupported extension", async () => {
    const app = await createTestApp();
    const res = await app.request("/somefile.txt");
    expect(res.status).toBe(404);
  });

  it("GET with path traversal attempt does not return 200", async () => {
    const app = await createTestApp();
    // URL-level path normalization resolves ../ before routing,
    // so the handler either rejects with 403 or treats the encoded
    // dots as a literal filename (404). Either way, traversal is blocked.
    const res = await app.request("/..%2F..%2F..%2Fetc%2Fpasswd.md");
    expect([403, 404]).toContain(res.status);
  });
});

describe("directory routes - security", () => {
  it("GET /view?path=../etc/passwd returns 403", async () => {
    const app = await createTestApp();
    const res = await app.request("/view?path=../etc/passwd");
    expect(res.status).toBe(403);
  });

  it("GET /view?path=./../../etc/passwd returns 403", async () => {
    const app = await createTestApp();
    const res = await app.request("/view?path=./../../etc/passwd");
    expect(res.status).toBe(403);
  });

  it("GET /view?path=page.html returns page with iframe", async () => {
    const app = await createTestApp();
    const res = await app.request("/view?path=page.html");
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("iframe");
    expect(html).toContain("page.html");
  });

  it("GET /view?path=docs returns 404 for directory path without supported extension", async () => {
    const app = await createTestApp();
    const res = await app.request("/view?path=docs");
    expect(res.status).toBe(404);
  });
});

describe("directory routes - relative assets", () => {
  it("GET / rewrites images of the first file against its directory", async () => {
    const app = await createTestApp();
    const res = await app.request("/");
    const html = await res.text();
    expect(html).toContain("Guide");
    expect(html).toContain('src="/__peek/raw/img.png"');
  });

  it("GET /view rewrites images against the Markdown file's directory", async () => {
    const app = await createTestApp();
    const res = await app.request("/view?path=docs/guide.md");
    const html = await res.text();
    expect(html).toContain('src="/__peek/raw/img.png"');
  });

  it("GET /view points the iframe and the external link at encoded paths", async () => {
    const app = await createTestApp();
    const res = await app.request(
      `/view?path=${encodeURIComponent("my docs/a page.html")}`,
    );
    const html = await res.text();
    expect(html).toContain('src="/__peek/raw/my%20docs/a%20page.html"');
    expect(html).toContain('href="/my%20docs/a%20page.html"');
  });

  it("GET /<path>.md rewrites images against the Markdown file's directory", async () => {
    const app = await createTestApp();
    const res = await app.request("/docs/guide.md");
    const html = await res.text();
    expect(html).toContain('src="/__peek/raw/img.png"');
  });

  it("GET /<path>.html points the iframe at the encoded raw path", async () => {
    const app = await createTestApp();
    const res = await app.request("/my%20docs/a%20page.html");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('src="/__peek/raw/my%20docs/a%20page.html"');
  });

  it("GET /raw/note.md opens a file in a directory named raw", async () => {
    const app = await createTestApp();
    const res = await app.request("/raw/note.md");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Raw Note");
  });
});
