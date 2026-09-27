import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initMarkdown } from "../../lib/markdown.js";
import { resolveStyles } from "../../lib/styles.js";
import { createFileRoutes } from "./file.js";

const testDir = join(import.meta.dirname, "__test_fixture__");
const testFile = join(testDir, "test.md");

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  writeFileSync(testFile, "# Test File\n\nHello world\n\n![logo](./img.png)");
  await initMarkdown();
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("file routes", () => {
  it("GET / returns rendered HTML page", async () => {
    const result = await resolveStyles();
    if (!result.ok) throw new Error("Failed to resolve styles");
    const app = createFileRoutes(testFile, result.value);

    const res = await app.request("/");
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("test.md - peek");
    expect(html).toContain("Test File");
    expect(html).toContain("Hello world");
  });

  it("GET / rewrites relative images against the file's directory", async () => {
    const result = await resolveStyles();
    if (!result.ok) throw new Error("Failed to resolve styles");
    const app = createFileRoutes(testFile, result.value);

    const res = await app.request("/");
    const html = await res.text();
    expect(html).toContain('<img src="/__peek/raw/img.png" alt="logo">');
  });
});

describe("file routes - edge cases", () => {
  it("returns 500 for non-existent file", async () => {
    const result = await resolveStyles();
    if (!result.ok) throw new Error("Failed to resolve styles");
    const app = createFileRoutes(
      join(testDir, "non-existent.md"),
      result.value,
    );

    const res = await app.request("/");
    expect(res.status).toBe(500);
  });

  it("returns 200 for empty markdown file", async () => {
    const emptyFile = join(testDir, "empty.md");
    writeFileSync(emptyFile, "");

    const result = await resolveStyles();
    if (!result.ok) throw new Error("Failed to resolve styles");
    const app = createFileRoutes(emptyFile, result.value);

    const res = await app.request("/");
    expect(res.status).toBe(200);
  });
});
