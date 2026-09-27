import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createFileTreeCache } from "../../lib/file-tree-cache.js";
import { initMarkdown } from "../../lib/markdown.js";
import { resolveStyles } from "../../lib/styles.js";
import { createDirectoryRoutes } from "./directory.js";

// The OS separator, switched per test to run the Windows branch on any host.
const os = vi.hoisted(() => ({ sep: "/" }));

vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return {
    ...actual,
    get sep() {
      return os.sep;
    },
  };
});

const testDir = join(import.meta.dirname, "__test_fixture_view_redirect__");

beforeAll(async () => {
  mkdirSync(join(testDir, "docs"), { recursive: true });
  writeFileSync(join(testDir, "docs", "guide.md"), "# Guide");
  if (process.platform !== "win32") {
    writeFileSync(join(testDir, "docs", "a\\b.md"), "# Backslash name");
  }
  await initMarkdown();
});

afterEach(() => {
  os.sep = "/";
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

describe("GET /view on Windows", () => {
  beforeEach(() => {
    os.sep = "\\";
  });

  it("redirects a \\-separated path to the /-separated one", async () => {
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
});

describe.skipIf(process.platform === "win32")("GET /view on POSIX", () => {
  it("renders a / path without redirecting", async () => {
    const app = await createTestApp();
    const res = await app.request("/view?path=docs%2Fguide.md");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Guide");
  });

  it("renders a file whose name contains a backslash without redirecting", async () => {
    const app = await createTestApp();
    const res = await app.request("/view?path=docs%2Fa%5Cb.md");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Backslash name");
  });
});
