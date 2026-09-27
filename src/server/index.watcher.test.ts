import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FileChangeCallback, FileWatcherHandle } from "../lib/watcher.js";
import type { SseManager } from "./routes/sse.js";

const watched: { callback?: FileChangeCallback } = {};
const broadcasts: [event: string, data: string][] = [];

vi.mock("../lib/watcher.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/watcher.js")>();
  return {
    ...actual,
    createFileWatcher: (): FileWatcherHandle => ({
      watchFile: () => {},
      watchDirectory: (_dirPath, callback) => {
        watched.callback = callback;
      },
      close: () => {},
    }),
  };
});

vi.mock("./routes/sse.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./routes/sse.js")>();
  return {
    ...actual,
    createSseManager: (): SseManager => {
      const manager = actual.createSseManager();
      return {
        ...manager,
        broadcast: (event, data) => {
          broadcasts.push([event, data]);
          manager.broadcast(event, data);
        },
      };
    },
  };
});

// `fs.watch` reports `\`-separated file names on Windows.
vi.mock("../core/path.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/path.js")>();
  return {
    ...actual,
    toSlashPath: (osPath: string) => osPath.replaceAll("\\", "/"),
  };
});

const { resolveStyles } = await import("../lib/styles.js");
const { startServer } = await import("./index.js");

const testDir = join(import.meta.dirname, "__test_server_watcher_fixture__");

beforeAll(() => {
  mkdirSync(join(testDir, "docs"), { recursive: true });
  writeFileSync(join(testDir, "docs", "a.md"), "# A");
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("directory watcher", () => {
  it("notifies the changed file with its path passed through toSlashPath", async () => {
    const styles = await resolveStyles();
    if (!styles.ok) throw new Error("Failed to resolve styles");
    const instance = await startServer({
      mode: "directory",
      targetPath: testDir,
      port: 0,
      hostname: "localhost",
      styles: styles.value,
    });
    try {
      watched.callback?.("docs\\a.md");
      expect(broadcasts).toEqual([
        ["file-changed", JSON.stringify({ path: "docs/a.md" })],
        ["tree-changed", JSON.stringify({})],
      ]);
    } finally {
      await instance.shutdown();
    }
  });
});
