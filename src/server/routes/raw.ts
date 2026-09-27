import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { getMimeType, SVG_MIME_TYPE } from "../../core/mime-type.js";
import { resolveWithinBase } from "../../core/path.js";
import { RAW_FILE_PREFIX } from "../../core/url.js";
import { logger } from "../../lib/logger.js";
import { isNotFoundError } from "../../lib/node-error.js";
import {
  type RealPathWithinBaseError,
  realPathWithinBase,
} from "../../lib/real-path.js";
import { realPathErrorResponse } from "./real-path-error.js";

type RawFileLookup =
  | {
      readonly type: "found";
      readonly body: Buffer<ArrayBuffer>;
      readonly mimeType: string;
    }
  | { readonly type: "path-error"; readonly error: RealPathWithinBaseError }
  | { readonly type: "not-allowed" }
  | { readonly type: "unreadable"; readonly cause: unknown };

async function lookupRawFile(
  baseDir: string,
  relativePath: string,
): Promise<RawFileLookup> {
  if (resolveWithinBase(baseDir, relativePath) === null) {
    return { type: "path-error", error: { type: "outside-base" } };
  }
  const realPath = await realPathWithinBase(baseDir, relativePath);
  if (!realPath.ok) {
    return { type: "path-error", error: realPath.error };
  }
  // Checked on the real path, so that a symlink cannot disguise a file that
  // is not on the allowlist.
  const mimeType = getMimeType(realPath.value);
  if (!mimeType) {
    return { type: "not-allowed" };
  }
  try {
    return { type: "found", body: await readFile(realPath.value), mimeType };
  } catch (e: unknown) {
    return isNotFoundError(e)
      ? { type: "path-error", error: { type: "not-found" } }
      : { type: "unreadable", cause: e };
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
      case "path-error": {
        const { status, message } = realPathErrorResponse(file.error);
        return c.text(message, status);
      }
      case "not-allowed":
        return c.text("Not found", 404);
      case "unreadable":
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
