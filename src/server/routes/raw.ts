import { readFile, realpath } from "node:fs/promises";
import { normalize, resolve } from "node:path";
import { Hono } from "hono";
import { getMimeType, SVG_MIME_TYPE } from "../../core/mime-type.js";
import { isWithinBase } from "../../core/path.js";
import { RAW_FILE_PREFIX } from "../../core/url.js";
import { logger } from "../../lib/logger.js";
import { isNodeError } from "../../lib/node-error.js";

type RawFileLookup =
  | {
      readonly type: "found";
      readonly body: Buffer<ArrayBuffer>;
      readonly mimeType: string;
    }
  | { readonly type: "outside-base" }
  | { readonly type: "not-found" }
  | { readonly type: "read-error"; readonly cause: unknown };

const NOT_FOUND_CODES: ReadonlySet<string> = new Set([
  "ENOENT",
  "ENOTDIR",
  "EISDIR",
]);

async function lookupRawFile(
  baseDir: string,
  relativePath: string,
): Promise<RawFileLookup> {
  const fullPath = resolve(baseDir, normalize(relativePath));
  if (!isWithinBase(baseDir, fullPath)) {
    return { type: "outside-base" };
  }
  try {
    // Real paths, so that a symlink can neither lead outside `baseDir` nor
    // disguise a file that is not on the allowlist.
    const [realBase, realTarget] = await Promise.all([
      realpath(baseDir),
      realpath(fullPath),
    ]);
    if (!isWithinBase(realBase, realTarget)) {
      return { type: "outside-base" };
    }
    const mimeType = getMimeType(realTarget);
    if (!mimeType) {
      return { type: "not-found" };
    }
    return { type: "found", body: await readFile(realTarget), mimeType };
  } catch (e: unknown) {
    if (isNodeError(e) && e.code !== undefined && NOT_FOUND_CODES.has(e.code)) {
      return { type: "not-found" };
    }
    return { type: "read-error", cause: e };
  }
}

/**
 * Serves allowlisted files under `baseDir` at `/__peek/raw/<relative path>`,
 * so that the browser resolves relative references in a previewed file
 * (images, CSS, fonts, ...) against that file's own directory.
 */
export function createRawRoutes(baseDir: string): Hono {
  const app = new Hono();

  app.get(`${RAW_FILE_PREFIX}:path{.+}`, async (c) => {
    const file = await lookupRawFile(baseDir, c.req.param("path"));
    switch (file.type) {
      case "outside-base":
        return c.text("Forbidden", 403);
      case "not-found":
        return c.text("Not found", 404);
      case "read-error":
        logger.error("Failed to read file:", file.cause);
        return c.text("Failed to read file", 500);
      case "found":
        break;
    }

    c.header("Content-Type", file.mimeType);
    c.header("X-Content-Type-Options", "nosniff");
    // Live reload re-requests assets, which must not come from a stale cache.
    c.header("Cache-Control", "no-cache");
    if (file.mimeType === SVG_MIME_TYPE) {
      // Opened directly, an SVG would otherwise run scripts on peek's origin.
      c.header("Content-Security-Policy", "sandbox");
    }
    // HTML gets no CSP on purpose (ADR 0036): it is the user's own file,
    // previewed with full HTML expressiveness.
    return c.body(file.body);
  });

  return app;
}
