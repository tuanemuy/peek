import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
import type { FileChangeCallback, FileWatcherHandle } from "../lib/watcher.js";
import { osSeparator } from "../test-utils/os-separator.js";
import type { ServerInstance } from "./index.js";
import type { SseManager } from "./routes/sse.js";

const watched = vi.hoisted(() => ({
  callback: undefined as FileChangeCallback | undefined,
}));
const broadcasts = vi.hoisted((): [event: string, data: string][] => []);

// `sep` follows `osSeparator`, to run the Windows branch on any host.
vi.mock("node:path", async (importOriginal) => {
  const { withSwitchableSep } = await import("../test-utils/os-separator.js");
  return withSwitchableSep(await importOriginal<typeof import("node:path")>());
});

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

const { resolveStyles } = await import("../lib/styles.js");
const { startServer } = await import("./index.js");

const testDir = join(import.meta.dirname, "__test_server_watcher_fixture__");
let instance: ServerInstance;

beforeAll(async () => {
  mkdirSync(join(testDir, "docs"), { recursive: true });
  writeFileSync(join(testDir, "docs", "a.md"), "# A");
  const styles = await resolveStyles();
  if (!styles.ok) throw new Error("Failed to resolve styles");
  instance = await startServer({
    mode: "directory",
    targetPath: testDir,
    port: 0,
    hostname: "localhost",
    styles: styles.value,
  });
});

afterEach(() => {
  osSeparator.value = undefined;
  broadcasts.length = 0;
});

afterAll(async () => {
  await instance.shutdown();
  rmSync(testDir, { recursive: true, force: true });
});

function notify(fileName: string): void {
  if (!watched.callback) throw new Error("watchDirectory was not called");
  watched.callback(fileName);
}

describe("directory watcher notifications", () => {
  it("separates the changed file's path with / on Windows", () => {
    osSeparator.value = "\\";
    notify("docs\\a.md");
    expect(broadcasts).toEqual([
      ["file-changed", JSON.stringify({ path: "docs/a.md" })],
      ["tree-changed", JSON.stringify({})],
    ]);
  });

  it("keeps a backslash as part of a file name on POSIX", () => {
    osSeparator.value = "/";
    notify("docs/a\\b.md");
    expect(broadcasts).toEqual([
      ["file-changed", JSON.stringify({ path: "docs/a\\b.md" })],
      ["tree-changed", JSON.stringify({})],
    ]);
  });
});
