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
   * Upper bound for waiting on `server.close()` inside `shutdown()`.
   * Defaults to `SHUTDOWN_TIMEOUT_MS`.
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
 * Upper bound for waiting on `server.close()`. Normally it resolves within a
 * tick after `closeAllConnections()`, so this is mostly margin for slow
 * environments — short enough to keep Ctrl+C responsive, long enough not to
 * warn on healthy shutdowns.
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
  const runShutdown = async (): Promise<void> => {
    // 1. Stop the listener first. Every step below can make a browser
    //    reconnect — aborting an SSE stream and destroying a socket both fire
    //    `onerror` in the client — and once the listener is gone those attempts
    //    fail at the TCP level. Going first also keeps `closing` reachable when
    //    a later step throws.
    const closing = close();
    // Steps 2-4 are isolated from step 5: whatever fails there, the wait on
    // `closing` still has to happen (and stay bounded), or shutdown() could
    // hang on the very thing it exists to end. The failure is rethrown after.
    let failure: { readonly error: unknown } | undefined;
    try {
      // 2. Refuse new /sse requests and abort the streams already running.
      sse.shutdown();
      // 3. No further file events, hence no further broadcasts.
      watcher.close();
      // 4. Destroy the sockets that are still active. `server.close()` takes
      //    care of the idle keep-alive ones itself (Node >= 19 calls
      //    `closeIdleConnections()` from within `close()`), but it would wait
      //    forever on the in-flight SSE responses.
      //    `serve()` returns `ServerType` (http.Server | Http2Server |
      //    Http2SecureServer) and only `http.Server` has this method, so the
      //    union has to be narrowed; peek always creates a plain HTTP server.
      if ("closeAllConnections" in server) {
        server.closeAllConnections();
      }
    } catch (error) {
      failure = { error };
    }
    // 5. Wait, but never indefinitely — the root cause of the reported hang is
    //    unknown, so a bounded wait is what guarantees termination.
    const outcome = await withTimeout(closing, shutdownTimeoutMs);
    if (outcome.status === "timed-out") {
      logger.warn(
        `HTTP server did not close within ${shutdownTimeoutMs}ms — giving up and leaving the remaining sockets to the caller.`,
      );
    }
    if (failure) {
      throw failure.error;
    }
  };

  let shutdownPromise: Promise<void> | undefined;

  return {
    shutdown() {
      if (shutdownPromise) return shutdownPromise;
      // Publish the memo *before* running any step. `shutdownPromise =
      // runShutdown()` would only be assigned once `runShutdown()` reached its
      // first `await`, leaving the re-entrancy guard open for the whole
      // synchronous part — exactly the kind of "safe because it happens to be
      // synchronous" that this shutdown path is meant to stop relying on.
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      shutdownPromise = promise;
      runShutdown().then(resolve, reject);
      return promise;
    },
  };
}
