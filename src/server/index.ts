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

export type StartServerOptions = {
  /**
   * Upper bound (ms) for waiting on `server.close()` inside `shutdown()`.
   * Defaults to 2,000ms. A non-positive value (or `NaN`) means "give up
   * immediately and warn" — it does *not* mean "wait forever".
   */
  readonly shutdownTimeoutMs?: number;
};

export type ServerInstance = {
  /**
   * Stops everything: the HTTP listener, SSE streams and the file watcher.
   * Idempotent — later calls return the promise of the first one.
   *
   * Always settles within the shutdown budget (see
   * `StartServerOptions.shutdownTimeoutMs`). When that budget elapses, sockets
   * may still be alive; ending the process is the caller's (the CLI's)
   * responsibility.
   */
  readonly shutdown: () => Promise<void>;
};

/**
 * `server.close()` normally resolves a tick after `closeAllConnections()`, so
 * this is mostly margin for slow environments: long enough not to warn on
 * healthy shutdowns, short enough to keep Ctrl+C responsive.
 */
const SHUTDOWN_TIMEOUT_MS = 2_000;

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
  options?: StartServerOptions,
): Promise<ServerInstance> {
  const shutdownTimeoutMs = options?.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS;
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
  // The order of the steps below matters, and each one runs even if an earlier
  // one throws: skipping a step costs either termination speed or the bounded
  // wait itself. Failures are collected so none of them is lost to another.
  const runShutdown = async (): Promise<void> => {
    const failures: unknown[] = [];
    const step = (run: () => void) => {
      try {
        run();
      } catch (error) {
        failures.push(error);
      }
    };

    // 1. Stop the listener first: every step below can make a browser
    //    reconnect (both an aborted SSE stream and a destroyed socket fire
    //    `onerror`), and once the listener is gone those attempts fail at the
    //    TCP level.
    const closing = close();
    // 2. Refuse new /sse requests and abort the streams already running.
    step(() => sse.shutdown());
    // 3. No further file events, hence no further broadcasts.
    step(() => watcher.close());
    // 4. Destroy the sockets that are still active — skip this and step 5
    //    burns its whole budget. The idle keep-alive ones need no help (Node
    //    >= 19 calls `closeIdleConnections()` from within `close()`), but
    //    `close()` would wait forever on the in-flight SSE responses.
    //    Only `http.Server` has this method, and `serve()` returns a union
    //    with Http2; peek always creates a plain HTTP server.
    step(() => {
      if ("closeAllConnections" in server) {
        server.closeAllConnections();
      }
    });
    // 5. Wait, but never indefinitely — the root cause of the reported hang is
    //    unknown, so a bounded wait is what guarantees termination.
    try {
      const outcome = await withTimeout(closing, shutdownTimeoutMs);
      if (outcome.status === "timed-out") {
        logger.warn(
          `HTTP server did not close within ${shutdownTimeoutMs}ms — giving up and leaving the remaining sockets to the caller.`,
        );
      }
    } catch (error) {
      failures.push(error);
    }

    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Failed to shut down the server.");
    }
  };

  let shutdownPromise: Promise<void> | undefined;

  return {
    shutdown() {
      if (shutdownPromise) return shutdownPromise;
      // Publish the memo *before* running any step: `shutdownPromise =
      // runShutdown()` would only be assigned once `runShutdown()` yields,
      // leaving the guard open for its whole synchronous part.
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      shutdownPromise = promise;
      runShutdown().then(resolve, reject);
      return promise;
    },
  };
}
