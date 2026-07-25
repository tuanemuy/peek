import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
import type { ServerInstance } from "./index.js";
import { startServer } from "./index.js";

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

beforeAll(() => {
  mkdirSync(testDir, { recursive: true });
  writeFileSync(htmlFile, "<html><body><h1>Test</h1></body></html>");
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

/**
 * Regression guard for the step order of ADR-002: `server.close()` runs first,
 * `closeAllConnections()` after it, and both before `shutdown()` yields.
 *
 * Steps 1-4 are all synchronous, so no black-box observation through a real
 * socket can tell the two orders apart; stubbing `serve()` is what makes the
 * order observable at all. Moving `const closing = close()` back below
 * `closeAllConnections()` flips the recorded array and fails here.
 */
describe("shutdown step order", () => {
  it("closes the listener before destroying live connections, both before yielding", async () => {
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

    try {
      const { startServer } = await import("./index.js");
      const instance = await startServer({ ...baseConfig, port: 0 });

      const shutting = instance.shutdown();
      shutting.catch(() => {});
      // Read before awaiting: anything recorded here happened before the first
      // `await` inside `shutdown()`, which is the contract AC-4 states.
      expect(calls).toEqual(["close", "closeAllConnections"]);
      await shutting;
    } finally {
      vi.doUnmock("@hono/node-server");
      vi.resetModules();
    }
  });
});
