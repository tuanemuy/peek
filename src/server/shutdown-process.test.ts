import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");
const fixtureDir = join(import.meta.dirname, "__test_shutdown_fixture__");

// Duplicated from `index.test.ts` on purpose — extracting a shared helper is
// out of scope for this change.
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
 */
async function waitForServer(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/`);
      await res.arrayBuffer();
      if (res.status === 200) return;
    } catch {
      // Not listening yet — keep polling.
    }
    await delay(150);
  }
  throw new Error(`Server did not start within ${timeoutMs}ms`);
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
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    let sse: Response | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    try {
      await waitForServer(port, 20_000);

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

      expect(result, `Output:\n${output}`).toBe(0);
      expect(elapsedMs).toBeLessThan(5_000);
    } finally {
      if (killTimer) clearTimeout(killTimer);
      await sse?.body?.cancel().catch(() => {});
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  });
});
