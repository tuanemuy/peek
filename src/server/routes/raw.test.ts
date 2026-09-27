import {
  chmodSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRawRoutes } from "./raw.js";

const fixtureDir = join(import.meta.dirname, "__test_fixture_raw__");
const baseDir = join(fixtureDir, "base");
const outsideDir = join(fixtureDir, "outside");
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

beforeAll(() => {
  mkdirSync(join(baseDir, "docs", "sub"), { recursive: true });
  mkdirSync(join(baseDir, "raw"), { recursive: true });
  mkdirSync(join(baseDir, "dir.png"), { recursive: true });
  mkdirSync(join(baseDir, "my docs"), { recursive: true });
  mkdirSync(outsideDir, { recursive: true });

  writeFileSync(join(baseDir, "img.png"), PNG_BYTES);
  writeFileSync(join(baseDir, "docs", "sub", "deep.png"), PNG_BYTES);
  writeFileSync(join(baseDir, "my docs", "画像 1.png"), PNG_BYTES);
  writeFileSync(join(baseDir, "style.css"), "body { color: red; }");
  writeFileSync(join(baseDir, "page.html"), "<h1>Page</h1>");
  writeFileSync(join(baseDir, "icon.svg"), "<svg></svg>");
  writeFileSync(join(baseDir, "raw", "note.png"), PNG_BYTES);
  writeFileSync(join(baseDir, "secret.txt"), "secret");
  writeFileSync(join(baseDir, "unreadable.png"), PNG_BYTES);
  chmodSync(join(baseDir, "unreadable.png"), 0o000);
  writeFileSync(join(outsideDir, "outside.png"), PNG_BYTES);

  symlinkSync(join(outsideDir, "outside.png"), join(baseDir, "escape.png"));
  symlinkSync(outsideDir, join(baseDir, "escape-dir"));
  symlinkSync(join(baseDir, "secret.txt"), join(baseDir, "disguised.png"));
  symlinkSync(join(baseDir, "img.png"), join(baseDir, "alias.png"));
  symlinkSync(join(baseDir, "icon.svg"), join(baseDir, "svg-alias.png"));
});

afterAll(() => {
  chmodSync(join(baseDir, "unreadable.png"), 0o644);
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe("raw routes - serving", () => {
  const app = createRawRoutes(baseDir);

  it("returns the file's bytes with its MIME type and headers", async () => {
    const res = await app.request("/__peek/raw/img.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it("serves files in subdirectories", async () => {
    const res = await app.request("/__peek/raw/docs/sub/deep.png");
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it("decodes percent-encoded segments", async () => {
    const res = await app.request(
      `/__peek/raw/my%20docs/${encodeURIComponent("画像 1.png")}`,
    );
    expect(res.status).toBe(200);
  });

  it("serves CSS as UTF-8 text", async () => {
    const res = await app.request("/__peek/raw/style.css");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/css; charset=utf-8");
    expect(await res.text()).toBe("body { color: red; }");
  });

  it("serves HTML without a Content-Security-Policy", async () => {
    const res = await app.request("/__peek/raw/page.html");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
    expect(await res.text()).toBe("<h1>Page</h1>");
  });

  it("sandboxes SVG with a Content-Security-Policy", async () => {
    const res = await app.request("/__peek/raw/icon.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(res.headers.get("Content-Security-Policy")).toBe("sandbox");
  });

  it("serves a symlink that stays within the base directory", async () => {
    const res = await app.request("/__peek/raw/alias.png");
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it("takes the MIME type from the file a symlink points to", async () => {
    const res = await app.request("/__peek/raw/svg-alias.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(res.headers.get("Content-Security-Policy")).toBe("sandbox");
  });

  it("serves files in a directory named raw", async () => {
    const res = await app.request("/__peek/raw/raw/note.png");
    expect(res.status).toBe(200);
  });
});

describe("raw routes - refusals", () => {
  const app = createRawRoutes(baseDir);

  it("returns 403 for an encoded path that climbs above the base", async () => {
    const res = await app.request("/__peek/raw/..%2Foutside%2Foutside.png");
    expect(res.status).toBe(403);
  });

  it("returns 403 for an encoded path above the base that does not exist", async () => {
    const res = await app.request("/__peek/raw/..%2F..%2Fnope.txt");
    expect(res.status).toBe(403);
  });

  it("returns 403 for a symlinked file that points outside the base", async () => {
    const res = await app.request("/__peek/raw/escape.png");
    expect(res.status).toBe(403);
  });

  it("returns 403 for a file under a symlinked directory outside the base", async () => {
    const res = await app.request("/__peek/raw/escape-dir/outside.png");
    expect(res.status).toBe(403);
  });

  it("returns 404 for an extension that is not on the allowlist", async () => {
    const res = await app.request("/__peek/raw/secret.txt");
    expect(res.status).toBe(404);
  });

  it("returns 404 for a symlink whose target is not on the allowlist", async () => {
    const res = await app.request("/__peek/raw/disguised.png");
    expect(res.status).toBe(404);
  });

  it("returns 404 for a file that does not exist", async () => {
    const res = await app.request("/__peek/raw/missing.png");
    expect(res.status).toBe(404);
  });

  it("returns 404 when a path segment is a file", async () => {
    const res = await app.request("/__peek/raw/img.png/child.png");
    expect(res.status).toBe(404);
  });

  it("returns 404 for a directory", async () => {
    const res = await app.request("/__peek/raw/dir.png");
    expect(res.status).toBe(404);
  });

  // root can read a mode-000 file.
  it.skipIf(process.getuid?.() === 0)(
    "returns 500 when the file cannot be read",
    async () => {
      const res = await app.request("/__peek/raw/unreadable.png");
      expect(res.status).toBe(500);
    },
  );

  it("returns 404 when the base directory does not exist", async () => {
    const missingBaseApp = createRawRoutes(join(fixtureDir, "missing"));
    const res = await missingBaseApp.request("/__peek/raw/img.png");
    expect(res.status).toBe(404);
  });
});

describe("raw routes - file mode base directory", () => {
  // In file mode the base is the previewed file's directory.
  const app = createRawRoutes(join(baseDir, "docs"));

  it("serves files next to the previewed file", async () => {
    const res = await app.request("/__peek/raw/sub/deep.png");
    expect(res.status).toBe(200);
  });

  it("returns 403 for a parent directory's file", async () => {
    const res = await app.request("/__peek/raw/..%2Fimg.png");
    expect(res.status).toBe(403);
  });
});
