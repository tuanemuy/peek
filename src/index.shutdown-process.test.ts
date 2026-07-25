/**
 * Process-level check for AC-1. The subject is the CLI entry (`./index.ts`),
 * not anything under `src/server/`, hence the colocation here.
 */
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..");
const fixtureDir = join(import.meta.dirname, "__test_shutdown_fixture__");

// Duplicated from `server/index.test.ts` on purpose — extracting a shared
// helper is out of scope for this change.
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls the HTTP endpoint instead of matching stdout, because the CLI output is
 * decorated by @clack and differs between TTY and pipe.
 *
 * Bails out as soon as the child is gone: `getFreePort()` hands out a port that
 * anyone can take before the child binds it, and that window is wide here
 * (spawn → tsx transpile → shiki init → bind). Without this, a child that died
 * instantly with `Port N is already in use` surfaces 20s later as a bare "did
 * not start", with the real reason sitting unread in `output`.
 */
async function waitForServer(
  child: ChildProcess,
  port: number,
  timeoutMs: number,
  getOutput: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `peek exited before it started listening (code=${child.exitCode}, signal=${child.signalCode}).\nOutput:\n${getOutput()}`,
      );
    }
    try {
      // Bounded: whoever else holds the port may accept the connection and
      // never answer, and an unbounded `fetch` here would park the loop for
      // good — including the exit check above.
      const res = await fetch(`http://localhost:${port}/`, {
        signal: AbortSignal.timeout(1_000),
      });
      await res.arrayBuffer();
      if (res.status === 200) return;
    } catch {
      // Not listening yet — keep polling.
    }
    await delay(150);
  }
  throw new Error(
    `Server did not start within ${timeoutMs}ms.\nOutput:\n${getOutput()}`,
  );
}

beforeAll(() => {
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(join(fixtureDir, "README.md"), "# Test\n");
});

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe("peek CLI shutdown", () => {
  it("exits with code 0 within 5 seconds after a single SIGINT while an SSE client is connected", async () => {
    const port = await getFreePort();
    const child = spawn(
      process.execPath,
      [
        "--import",
        "./src/loaders/css.mjs",
        "--import",
        "tsx/esm",
        "src/index.ts",
        fixtureDir,
        "--port",
        String(port),
        "--no-open",
      ],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    );

    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    let sse: Response | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    try {
      await waitForServer(child, port, 20_000, () => output);

      sse = await fetch(`http://localhost:${port}/sse`);
      expect(sse.status).toBe(200);

      const closed = new Promise<number | null>((resolve) => {
        child.once("close", (code) => resolve(code));
      });
      const timedOut = new Promise<"timed-out">((resolve) => {
        killTimer = setTimeout(() => resolve("timed-out"), 10_000);
      });

      const startedAt = Date.now();
      child.kill("SIGINT");
      const result = await Promise.race([closed, timedOut]);
      const elapsedMs = Date.now() - startedAt;

      if (result === "timed-out") {
        child.kill("SIGKILL");
        throw new Error(`peek did not exit after SIGINT.\nOutput:\n${output}`);
      }

      // `outro("Server stopped. Bye!")` runs right after `await
      // server.shutdown()` and immediately before `process.exit(0)`, so its
      // presence is the evidence that `shutdown()` actually settled.
      //
      // This is what makes the test discriminating — exit code 0 alone proves
      // nothing here. The synchronous part of `shutdown()` releases every ref'd
      // handle, so a `shutdown()` that never settles drains the event loop and
      // Node exits on its own, with code 0, in a handful of milliseconds.
      // Measured: a permanently hung `shutdown()` gives exit 0 / 6ms and no
      // "Server stopped", i.e. indistinguishable from a healthy run by exit
      // code and timing alone.
      expect(output, `Output:\n${output}`).toContain("Server stopped");
      expect(result, `Output:\n${output}`).toBe(0);

      // AC-1 asks for 5s, but a healthy shutdown must not merely fit the
      // deadline — it must never reach the 2s bounded wait that exists as a
      // last resort. Asserting against the budget instead of the deadline is
      // what catches a shutdown that only terminates because the timeout
      // rescued it. Measured: healthy 5-7ms; without `closeAllConnections()`
      // the wait is what ends it (~2s + the warning below, or ~4s and exit 0
      // in the unbounded pre-fix shape, both of which sit inside 5s).
      expect(elapsedMs, `Output:\n${output}`).toBeLessThan(2_000);
      // AC-3 at process level: no false-positive warning on a healthy
      // shutdown, and a real one if the sockets are ever left to the timeout.
      expect(output, `Output:\n${output}`).not.toContain(
        "did not close within",
      );
    } finally {
      if (killTimer) clearTimeout(killTimer);
      await sse?.body?.cancel().catch(() => {});
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  });
});
