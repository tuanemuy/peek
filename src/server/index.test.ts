import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { initMarkdown } from "../lib/markdown.js";
import { resolveStyles } from "../lib/styles.js";
import type { FileWatcherHandle } from "../lib/watcher.js";
import type { ServerInstance } from "./index.js";
import { startServer } from "./index.js";
import type { SseManager } from "./routes/sse.js";

const testDir = join(import.meta.dirname, "__test_server_fixture__");
const htmlFile = join(testDir, "test.html");

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, () => {
      const addr = srv.address() as AddressInfo;
      srv.close((err) => (err ? reject(err) : resolve(addr.port)));
    });
  });
}

const baseConfig = {
  targetPath: htmlFile,
  mode: "file" as const,
  hostname: "localhost",
  contentType: "html" as const,
};

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

beforeAll(() => {
  mkdirSync(testDir, { recursive: true });
  writeFileSync(htmlFile, "<html><body><h1>Test</h1></body></html>");
  writeFileSync(join(testDir, "img.png"), PNG_BYTES);
  writeFileSync(join(testDir, "readme.md"), "![logo](./img.png)");
  mkdirSync(join(testDir, "raw"), { recursive: true });
  writeFileSync(join(testDir, "raw", "note.md"), "# Raw Note");
  mkdirSync(join(testDir, "real"), { recursive: true });
  writeFileSync(join(testDir, "real", "page.html"), '<img src="./pic.png">');
  writeFileSync(join(testDir, "real", "pic.png"), PNG_BYTES);
  writeFileSync(join(testDir, "real", "notes.md"), "![pic](./pic.png)");
  mkdirSync(join(testDir, "links"), { recursive: true });
  symlinkSync(
    join(testDir, "real", "page.html"),
    join(testDir, "links", "link.html"),
  );
  symlinkSync(
    join(testDir, "real", "notes.md"),
    join(testDir, "links", "link.md"),
  );
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("startServer / shutdown lifecycle", () => {
  let server: ServerInstance | undefined;

  afterEach(async () => {
    await server?.shutdown().catch(() => {});
    server = undefined;
  });

  it("startServer starts server and responds to HTTP requests", async () => {
    const port = await getFreePort();
    server = await startServer({ ...baseConfig, port });

    const res = await fetch(`http://localhost:${port}/`);
    expect(res.status).toBe(200);
  });

  it("shutdown resolves without error", async () => {
    const port = await getFreePort();
    server = await startServer({ ...baseConfig, port });

    await expect(server.shutdown()).resolves.toBeUndefined();
    server = undefined;
  });

  it("server does not accept connections after shutdown", async () => {
    const port = await getFreePort();
    server = await startServer({ ...baseConfig, port });

    await server.shutdown();
    server = undefined;

    await expect(fetch(`http://localhost:${port}/`)).rejects.toThrow();
  });

  it("calling shutdown twice resolves safely (idempotent)", async () => {
    const port = await getFreePort();
    server = await startServer({ ...baseConfig, port });

    await server.shutdown();
    await expect(server.shutdown()).resolves.toBeUndefined();
    server = undefined;
  });

  it("concurrent shutdown calls resolve safely", async () => {
    const port = await getFreePort();
    server = await startServer({ ...baseConfig, port });

    await expect(
      Promise.all([server.shutdown(), server.shutdown()]),
    ).resolves.toEqual([undefined, undefined]);
    server = undefined;
  });

  it("stops accepting connections before shutdown() is awaited", async () => {
    const port = await getFreePort();
    server = await startServer({ ...baseConfig, port });

    const shutting = server.shutdown();
    // Attach a handler right away: nothing else observes `shutting` until the
    // `await` below, and `shutdown()` does propagate rejections (`withTimeout`
    // passes them through), which would surface as an unhandled rejection.
    // The `await` still re-throws, so a failure is not swallowed.
    shutting.catch(() => {});
    // End-to-end half of AC-4: a connection attempted after `shutdown()`
    // returned is refused. This says nothing about *when* inside `shutdown()`
    // the listener closed — `fetch()` only reaches TCP connect some
    // milliseconds later. The "before the first `await`" half is pinned down
    // synchronously by the ADR-002 ordering test below.
    await expect(fetch(`http://localhost:${port}/`)).rejects.toThrow();
    await shutting;
    server = undefined;
  });

  it("warns when the server does not close within the budget", async () => {
    const port = await getFreePort();
    server = await startServer(
      { ...baseConfig, port },
      { shutdownTimeoutMs: 0 },
    );

    const sse = await fetch(`http://localhost:${port}/sse`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await server.shutdown();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.join(" ")).toContain("did not close within");
    } finally {
      warn.mockRestore();
      await sse.body?.cancel().catch(() => {});
    }
    server = undefined;
  });

  it("does not warn on a healthy shutdown with an open SSE connection", async () => {
    const port = await getFreePort();
    server = await startServer({ ...baseConfig, port });

    const sse = await fetch(`http://localhost:${port}/sse`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await server.shutdown();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await sse.body?.cancel().catch(() => {});
    }
    server = undefined;
  });
});

describe("startServer / relative assets", () => {
  let server: ServerInstance | undefined;

  beforeAll(async () => {
    await initMarkdown();
  });

  afterEach(async () => {
    await server?.shutdown().catch(() => {});
    server = undefined;
  });

  async function startWithStyles(
    config:
      | { readonly mode: "directory"; readonly targetPath: string }
      | {
          readonly mode: "file";
          readonly contentType: "markdown";
          readonly targetPath: string;
        },
  ): Promise<number> {
    const styles = await resolveStyles();
    if (!styles.ok) throw new Error("Failed to resolve styles");
    const port = await getFreePort();
    server = await startServer({
      ...config,
      port,
      hostname: "localhost",
      styles: styles.value,
    });
    return port;
  }

  it("serves assets next to the file in HTML file mode", async () => {
    const port = await getFreePort();
    server = await startServer({ ...baseConfig, port });

    const res = await fetch(`http://localhost:${port}/__peek/raw/img.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
  });

  it("serves assets next to the file in Markdown file mode", async () => {
    const port = await startWithStyles({
      mode: "file",
      contentType: "markdown",
      targetPath: join(testDir, "readme.md"),
    });

    const page = await fetch(`http://localhost:${port}/`);
    expect(await page.text()).toContain('src="/__peek/raw/img.png"');
    const res = await fetch(`http://localhost:${port}/__peek/raw/img.png`);
    expect(res.status).toBe(200);
  });

  it("serves assets ahead of the catch-all route in directory mode", async () => {
    const port = await startWithStyles({
      mode: "directory",
      targetPath: testDir,
    });

    const res = await fetch(`http://localhost:${port}/__peek/raw/img.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
  });

  it("serves a symlinked HTML file and its assets from the real location", async () => {
    const port = await getFreePort();
    server = await startServer({
      ...baseConfig,
      targetPath: join(testDir, "links", "link.html"),
      port,
    });

    const page = await fetch(`http://localhost:${port}/`);
    expect(await page.text()).toContain('src="/__peek/raw/page.html"');
    const html = await fetch(`http://localhost:${port}/__peek/raw/page.html`);
    expect(html.status).toBe(200);
    const pic = await fetch(`http://localhost:${port}/__peek/raw/pic.png`);
    expect(pic.status).toBe(200);
  });

  it("serves the images of a symlinked Markdown file from the real location", async () => {
    const port = await startWithStyles({
      mode: "file",
      contentType: "markdown",
      targetPath: join(testDir, "links", "link.md"),
    });

    const page = await fetch(`http://localhost:${port}/`);
    expect(await page.text()).toContain('src="/__peek/raw/pic.png"');
    const pic = await fetch(`http://localhost:${port}/__peek/raw/pic.png`);
    expect(pic.status).toBe(200);
  });

  it("opens /raw/<file> as a page in directory mode", async () => {
    const port = await startWithStyles({
      mode: "directory",
      targetPath: testDir,
    });

    const res = await fetch(`http://localhost:${port}/raw/note.md`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Raw Note");
  });
});

/**
 * Boots `startServer()` against a stubbed `serve()`, `SseManager.shutdown()`
 * and `FileWatcherHandle.close()`, recording steps 1-4 in `calls` as they run.
 *
 * Steps 1-4 are all synchronous and step 4 destroys the very sockets an
 * observer would be watching, so their order is not visible through a real
 * socket. Stubbing is what makes them observable at all.
 */
async function withStubbedServer(
  run: (instance: ServerInstance, calls: string[]) => Promise<void>,
): Promise<void> {
  const calls: string[] = [];

  vi.resetModules();
  vi.doMock("@hono/node-server", () => ({
    serve: () => {
      const server = new EventEmitter();
      setTimeout(() => server.emit("listening"), 0);
      return Object.assign(server, {
        close(cb?: (err?: Error) => void) {
          calls.push("close");
          cb?.();
        },
        closeAllConnections() {
          calls.push("closeAllConnections");
        },
      });
    },
  }));
  vi.doMock("./routes/sse.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./routes/sse.js")>();
    return {
      ...actual,
      createSseManager: (): SseManager => {
        const manager = actual.createSseManager();
        return {
          app: manager.app,
          broadcast: manager.broadcast,
          shutdown: () => {
            calls.push("sse.shutdown");
            manager.shutdown();
          },
          get clientCount() {
            return manager.clientCount;
          },
        };
      },
    };
  });

  vi.doMock("../lib/watcher.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../lib/watcher.js")>();
    return {
      ...actual,
      createFileWatcher: (): FileWatcherHandle => {
        const watcher = actual.createFileWatcher();
        return {
          ...watcher,
          close: () => {
            calls.push("watcher.close");
            watcher.close();
          },
        };
      },
    };
  });

  try {
    const { startServer } = await import("./index.js");
    const instance = await startServer({ ...baseConfig, port: 0 });
    await run(instance, calls);
  } finally {
    vi.doUnmock("@hono/node-server");
    vi.doUnmock("./routes/sse.js");
    vi.doUnmock("../lib/watcher.js");
    vi.resetModules();
  }
}

/**
 * Regression guard for the step order of ADR-002: `server.close()` runs first,
 * `closeAllConnections()` after it, and both before `shutdown()` yields.
 * Moving `const closing = close()` back below `closeAllConnections()` flips the
 * recorded array and fails here.
 */
describe("shutdown step order", () => {
  it("closes the listener before destroying live connections, both before yielding", async () => {
    await withStubbedServer(async (instance, calls) => {
      const shutting = instance.shutdown();
      shutting.catch(() => {});
      // Read before awaiting: anything recorded here happened before the first
      // `await` inside `shutdown()`, which is the contract AC-4 states.
      expect(calls).toEqual([
        "close",
        "sse.shutdown",
        "watcher.close",
        "closeAllConnections",
      ]);
      await shutting;
    });
  });
});
