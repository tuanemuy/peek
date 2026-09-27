import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { getMimeType, SVG_MIME_TYPE } from "../../core/mime-type.js";
import { resolveWithinBase } from "../../core/path.js";
import { RAW_FILE_PREFIX } from "../../core/url.js";
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
  | RealPathWithinBaseError;

async function lookupRawFile(
  baseDir: string,
  relativePath: string,
): Promise<RawFileLookup> {
  const fullPath = resolveWithinBase(baseDir, relativePath);
  if (fullPath === null) {
    return { type: "outside-base" };
  }
  const realPath = await realPathWithinBase(baseDir, fullPath);
  if (!realPath.ok) {
    return realPath.error;
  }
  // Checked on the real path, so that a symlink cannot disguise a file that
  // is not on the allowlist.
  const mimeType = getMimeType(realPath.value);
  if (!mimeType) {
    return { type: "not-found" };
  }
  try {
    return { type: "found", body: await readFile(realPath.value), mimeType };
  } catch (e: unknown) {
    return isNotFoundError(e)
      ? { type: "not-found" }
      : { type: "io-error", cause: e };
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
    if (file.type !== "found") {
      const { status, message } = realPathErrorResponse(file);
      return c.text(message, status);
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
