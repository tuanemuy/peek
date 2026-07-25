import type { Server as HttpServer } from "node:http";
import type { ServerType } from "@hono/node-server";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { FileTreeCache } from "../lib/file-tree-cache.js";
import { createFileTreeCache } from "../lib/file-tree-cache.js";
import { logger } from "../lib/logger.js";
import type { ResolvedStyles } from "../lib/styles.js";
import type { FileWatcherHandle } from "../lib/watcher.js";
import { createFileWatcher } from "../lib/watcher.js";
import { withTimeout } from "../lib/with-timeout.js";
import { faviconBase64 } from "./renderer/favicon.js";
import type { ApiConfig } from "./routes/api.js";
import { createApiRoutes } from "./routes/api.js";
import { createDirectoryRoutes } from "./routes/directory.js";
import { createFileRoutes } from "./routes/file.js";
import { createHtmlFileRoutes } from "./routes/html-file.js";
import type { SseManager } from "./routes/sse.js";
import { createSseManager } from "./routes/sse.js";

export type ServerConfig =
  | {
      readonly mode: "file";
      readonly contentType: "html";
      readonly targetPath: string;
      readonly port: number;
      readonly hostname: string;
    }
  | {
      readonly mode: "file";
      readonly contentType: "markdown";
      readonly targetPath: string;
      readonly port: number;
      readonly hostname: string;
      readonly styles: ResolvedStyles;
    }
  | {
      readonly mode: "directory";
      readonly targetPath: string;
      readonly port: number;
      readonly hostname: string;
      readonly styles: ResolvedStyles;
    };

export type ServerInstance = {
  readonly watcher: FileWatcherHandle;
  /**
   * Stops everything: SSE streams, the file watcher and the HTTP server.
   *
   * Memoized — the first call wins, so `timeoutMs` is ignored on later calls.
   * Always settles within `timeoutMs` (default `SHUTDOWN_TIMEOUT_MS`). When the
   * budget elapses, sockets may still be alive; ending the process is the
   * caller's (the CLI's) responsibility.
   */
  readonly shutdown: (options?: {
    readonly timeoutMs?: number;
  }) => Promise<void>;
};

/**
 * Upper bound for waiting on `server.close()`. Normally it resolves within a
 * tick after `closeAllConnections()`, so this is mostly margin for slow
 * environments — short enough to keep Ctrl+C responsive, long enough not to
 * warn on healthy shutdowns.
 */
const SHUTDOWN_TIMEOUT_MS = 2_000;

/**
 * `serve()` returns `ServerType` (http.Server | Http2Server | Http2SecureServer);
 * `closeAllConnections` / `closeIdleConnections` exist only on `http.Server`.
 * peek always creates a plain HTTP server, so this narrows to that branch.
 */
function isHttpServer(server: ServerType): server is HttpServer {
  return "closeAllConnections" in server;
}

type AppContext =
  | {
      readonly mode: "file";
      readonly targetPath: string;
      readonly contentType: "html";
    }
  | {
      readonly mode: "file";
      readonly targetPath: string;
      readonly contentType: "markdown";
      readonly styles: ResolvedStyles;
    }
  | {
      readonly mode: "directory";
      readonly targetPath: string;
      readonly styles: ResolvedStyles;
      readonly treeCache: FileTreeCache;
    };

function createApp(ctx: AppContext, sse: SseManager): Hono {
  const app = new Hono();

  app.get("/favicon.ico", (c) => {
    if (!faviconBase64) {
      return c.body(null, 204);
    }
    const buf = Buffer.from(faviconBase64, "base64");
    return c.body(buf, 200, {
      "Content-Type": "image/x-icon",
      "Cache-Control": "public, max-age=86400",
    });
  });
  app.route("/", sse.app);

  if (ctx.mode === "file") {
    const apiRoutes = createApiRoutes({
      mode: "file",
      targetPath: ctx.targetPath,
    });
    app.route("/", apiRoutes);

    if (ctx.contentType === "html") {
      app.route("/", createHtmlFileRoutes(ctx.targetPath));
    } else {
      app.route("/", createFileRoutes(ctx.targetPath, ctx.styles));
    }
  } else {
    const apiConfig: ApiConfig = {
      mode: "directory",
      targetPath: ctx.targetPath,
      treeCache: ctx.treeCache,
    };
    app.route("/", createApiRoutes(apiConfig));
    app.route(
      "/",
      createDirectoryRoutes(ctx.targetPath, ctx.styles, ctx.treeCache),
    );
  }

  return app;
}

function setupWatcher(ctx: AppContext, sse: SseManager): FileWatcherHandle {
  const watcher = createFileWatcher();

  if (ctx.mode === "file") {
    watcher.watchFile(ctx.targetPath, () => {
      sse.broadcast("file-changed", JSON.stringify({}));
    });
  } else {
    watcher.watchDirectory(ctx.targetPath, (filePath) => {
      const normalizedPath = filePath.replace(/\\/g, "/");
      ctx.treeCache.invalidate();
      sse.broadcast("file-changed", JSON.stringify({ path: normalizedPath }));
      sse.broadcast("tree-changed", JSON.stringify({}));
    });
  }

  return watcher;
}

export async function startServer(
  config: ServerConfig,
): Promise<ServerInstance> {
  const sse = createSseManager();

  const ctx: AppContext =
    config.mode === "directory"
      ? {
          mode: "directory",
          targetPath: config.targetPath,
          styles: config.styles,
          treeCache: createFileTreeCache(config.targetPath),
        }
      : config.contentType === "html"
        ? {
            mode: "file",
            targetPath: config.targetPath,
            contentType: "html",
          }
        : {
            mode: "file",
            targetPath: config.targetPath,
            contentType: config.contentType,
            styles: config.styles,
          };

  const app = createApp(ctx, sse);
  const watcher = setupWatcher(ctx, sse);

  const server = serve({
    fetch: app.fetch,
    hostname: config.hostname,
    port: config.port,
  });

  await new Promise<void>((resolve, reject) => {
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    const onError = (err: Error) => {
      server.removeListener("listening", onListening);
      sse.shutdown();
      watcher.close();
      reject(err);
    };
    server.once("listening", onListening);
    server.once("error", onError);
  });

  // Memoized: calling `server.close()` twice makes the second callback fail
  // with ERR_SERVER_NOT_RUNNING.
  let closePromise: Promise<void> | undefined;
  const close = () => {
    closePromise ??= new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    return closePromise;
  };
  let shutdownPromise: Promise<void> | undefined;

  return {
    watcher,
    shutdown(options) {
      if (shutdownPromise) return shutdownPromise;
      const timeoutMs = options?.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
      shutdownPromise = (async () => {
        // 1. Refuse new /sse requests and abort the streams already running.
        sse.shutdown();
        // 2. Stop the listener before anything that could trigger a reconnect,
        //    so a browser reacting to step 4 can never be accepted again.
        const closing = close();
        // 3. No further file events, hence no further broadcasts.
        watcher.close();
        // 4. Destroy every remaining socket (active and idle). Without this,
        //    keep-alive sockets stay open and `server.close()` waits forever.
        if (isHttpServer(server)) {
          server.closeAllConnections();
        }
        // 5. Wait, but never indefinitely — the root cause of the reported hang
        //    is unknown, so a bounded wait is what guarantees termination.
        const outcome = await withTimeout(closing, timeoutMs);
        if (outcome.status === "timed-out") {
          logger.warn(
            `HTTP server did not close within ${timeoutMs}ms — giving up and leaving the remaining sockets to the caller.`,
          );
        }
      })();
      return shutdownPromise;
    },
  };
}
