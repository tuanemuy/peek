import { basename } from "node:path";
import { Hono } from "hono";
import renderToString from "preact-render-to-string";
import type { ContentType } from "../../core/content-type.js";
import { getContentType } from "../../core/content-type.js";
import { FULLSCREEN_IFRAME_STYLE } from "../../core/iframe-style.js";
import { resolveWithinBase } from "../../core/path.js";
import { rawFileUrl } from "../../core/url.js";
import type { FileTreeCache } from "../../lib/file-tree-cache.js";
import { logger } from "../../lib/logger.js";
import { renderMarkdown } from "../../lib/markdown.js";
import { readTextFile } from "../../lib/read-text-file.js";
import { realPathWithinBase } from "../../lib/real-path.js";
import { realPathErrorResponse } from "./real-path-error.js";

type FileApiConfig = {
  readonly mode: "file";
  readonly targetPath: string;
};

type DirectoryApiConfig = {
  readonly mode: "directory";
  readonly targetPath: string;
  readonly treeCache: FileTreeCache;
};

export type ApiConfig = FileApiConfig | DirectoryApiConfig;

function renderRawHtmlIframe(rawUrl: string, title: string): string {
  return renderToString(
    <iframe src={rawUrl} style={FULLSCREEN_IFRAME_STYLE} title={title} />,
  );
}

type ResolvedPath = {
  readonly relativePath: string;
  readonly fullPath: string;
  readonly contentType: ContentType;
};

function resolveAndValidatePath(
  basePath: string,
  query: string | undefined,
):
  | { ok: true; value: ResolvedPath }
  | { ok: false; status: 400 | 403 | 415; message: string } {
  if (!query) {
    return { ok: false, status: 400, message: "Missing path parameter" };
  }
  const fullPath = resolveWithinBase(basePath, query);
  if (fullPath === null) {
    return { ok: false, status: 403, message: "Forbidden" };
  }
  const contentType = getContentType(query);
  if (!contentType) {
    return { ok: false, status: 415, message: "Unsupported file type" };
  }
  return { ok: true, value: { relativePath: query, fullPath, contentType } };
}

export function createApiRoutes(config: ApiConfig): Hono {
  const app = new Hono();
  const fileContentType =
    config.mode === "file" ? getContentType(config.targetPath) : null;

  app.get("/api/content", async (c) => {
    if (config.mode === "file") {
      if (fileContentType === "html") {
        return c.html(
          renderRawHtmlIframe(
            rawFileUrl(basename(config.targetPath)),
            basename(config.targetPath),
          ),
        );
      }
      const result = await readTextFile(config.targetPath);
      if (!result.ok) {
        if (result.error.type === "file-not-found") {
          return c.text("File not found", 404);
        }
        logger.error("Failed to read file:", result.error);
        return c.text("Failed to read file", 500);
      }
      return c.html(
        await renderMarkdown(result.value, basename(config.targetPath)),
      );
    }

    const resolved = resolveAndValidatePath(
      config.targetPath,
      c.req.query("path"),
    );
    if (!resolved.ok) {
      return c.text(resolved.message, resolved.status);
    }
    const { relativePath, fullPath, contentType } = resolved.value;

    if (contentType === "html") {
      return c.html(
        renderRawHtmlIframe(rawFileUrl(relativePath), basename(relativePath)),
      );
    }

    const realPath = await realPathWithinBase(config.targetPath, fullPath);
    if (!realPath.ok) {
      const { status, message } = realPathErrorResponse(realPath.error);
      return c.text(message, status);
    }
    const result = await readTextFile(realPath.value);
    if (!result.ok) {
      if (result.error.type === "file-not-found") {
        return c.text("File not found", 404);
      }
      logger.error("Failed to read file:", result.error);
      return c.text("Failed to read file", 500);
    }
    return c.html(await renderMarkdown(result.value, relativePath));
  });

  app.get("/api/tree", async (c) => {
    if (config.mode === "file") {
      return c.json([]);
    }

    const result = await config.treeCache.get();
    if (!result.ok) {
      logger.error("Failed to read directory tree:", result.error);
      return c.text("Failed to read directory", 500);
    }
    return c.json(result.value);
  });

  return app;
}
