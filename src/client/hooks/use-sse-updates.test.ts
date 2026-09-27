import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import type { ContentType } from "../../core/content-type.js";
import { slash } from "../../test-utils/slash-path.js";
import type { SseCallbacks } from "../lib/sse.js";

// Mock useEffect to run callback synchronously (no DOM needed)
vi.mock("preact/hooks", () => ({
  useEffect: (fn: () => (() => void) | undefined) => {
    fn();
  },
}));

vi.mock("../lib/sse.js", () => ({
  createSseConnection: vi.fn(() => vi.fn()),
}));

vi.mock("../lib/api-client.js", () => ({
  fetchContent: vi.fn(),
  fetchTree: vi.fn(),
}));

// Import after mocks are set up
const { createSseConnection } = await import("../lib/sse.js");
const { fetchContent, fetchTree } = await import("../lib/api-client.js");
const { useSseUpdates } = await import("./use-sse-updates.js");

function getSseCallbacks(): SseCallbacks {
  return (createSseConnection as Mock).mock.calls.at(-1)?.[0] as SseCallbacks;
}

beforeEach(() => {
  vi.mocked(fetchContent).mockResolvedValue("<p>content</p>");
  vi.mocked(fetchTree).mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useSseUpdates", () => {
  describe("directory mode with HTML contentType", () => {
    it("calls onHtmlReload and skips fetchContent for HTML files", () => {
      const onContentUpdate = vi.fn();
      const onHtmlReload = vi.fn();

      useSseUpdates({
        onContentUpdate,
        onHtmlReload,
        getCurrentPath: () => "docs/page.html",
        getCurrentContentType: () => "html",
        onTreeUpdate: vi.fn(),
      });

      const { onFileChanged } = getSseCallbacks();
      onFileChanged(slash("docs/page.html"));

      expect(onHtmlReload).toHaveBeenCalledOnce();
      expect(onContentUpdate).not.toHaveBeenCalled();
      expect(fetchContent).not.toHaveBeenCalled();
    });

    it("does not call onHtmlReload for HTML files when path does not match", () => {
      const onContentUpdate = vi.fn();
      const onHtmlReload = vi.fn();

      useSseUpdates({
        onContentUpdate,
        onHtmlReload,
        getCurrentPath: () => "docs/page.html",
        getCurrentContentType: () => "html",
        onTreeUpdate: vi.fn(),
      });

      const { onFileChanged } = getSseCallbacks();
      onFileChanged(slash("other/file.html"));

      expect(onHtmlReload).not.toHaveBeenCalled();
      expect(onContentUpdate).not.toHaveBeenCalled();
      expect(fetchContent).not.toHaveBeenCalled();
    });
  });

  describe("directory mode with markdown contentType", () => {
    it("calls fetchContent with signal for markdown files", async () => {
      const onContentUpdate = vi.fn();

      useSseUpdates({
        onContentUpdate,
        getCurrentPath: () => "docs/readme.md",
        getCurrentContentType: () => "markdown",
        onTreeUpdate: vi.fn(),
      });

      const { onFileChanged } = getSseCallbacks();
      onFileChanged(slash("docs/readme.md"));

      // Wait for the fetchContent promise to resolve
      await vi.waitFor(() => {
        expect(fetchContent).toHaveBeenCalledWith("docs/readme.md", {
          signal: expect.any(AbortSignal),
        });
        expect(onContentUpdate).toHaveBeenCalledWith("<p>content</p>");
      });
    });
  });

  describe("directory mode HTML→MD→HTML file transitions", () => {
    it("changes behavior when contentType switches from HTML to MD to HTML", async () => {
      const onContentUpdate = vi.fn();
      const onHtmlReload = vi.fn();
      let currentPath = "page.html";
      let currentContentType: ContentType = "html";

      useSseUpdates({
        onContentUpdate,
        onHtmlReload,
        getCurrentPath: () => currentPath,
        getCurrentContentType: () => currentContentType,
        onTreeUpdate: vi.fn(),
      });

      const { onFileChanged } = getSseCallbacks();

      // Phase 1: HTML file — should call onHtmlReload, skip fetchContent
      onFileChanged(slash("page.html"));
      expect(onHtmlReload).toHaveBeenCalledOnce();
      expect(onContentUpdate).not.toHaveBeenCalled();
      expect(fetchContent).not.toHaveBeenCalled();

      // Phase 2: Navigate to MD (simulate DirectoryApp state change)
      currentPath = "readme.md";
      currentContentType = "markdown";
      onHtmlReload.mockClear();

      onFileChanged(slash("readme.md"));
      await vi.waitFor(() => {
        expect(fetchContent).toHaveBeenCalledWith("readme.md", {
          signal: expect.any(AbortSignal),
        });
        expect(onContentUpdate).toHaveBeenCalledWith("<p>content</p>");
      });
      expect(onHtmlReload).not.toHaveBeenCalled();

      // Phase 3: Navigate back to HTML
      currentPath = "page.html";
      currentContentType = "html";
      onContentUpdate.mockClear();
      onHtmlReload.mockClear();
      vi.mocked(fetchContent).mockClear();

      onFileChanged(slash("page.html"));
      expect(onHtmlReload).toHaveBeenCalledOnce();
      expect(onContentUpdate).not.toHaveBeenCalled();
      expect(fetchContent).not.toHaveBeenCalled();
    });
  });

  describe("directory mode general behavior", () => {
    it("ignores null changedPath", () => {
      const onContentUpdate = vi.fn();

      useSseUpdates({
        onContentUpdate,
        getCurrentPath: () => "docs/readme.md",
        getCurrentContentType: () => "markdown",
        onTreeUpdate: vi.fn(),
      });

      const { onFileChanged } = getSseCallbacks();
      onFileChanged(null);

      expect(onContentUpdate).not.toHaveBeenCalled();
      expect(fetchContent).not.toHaveBeenCalled();
    });

    it("ignores events for non-matching paths", () => {
      const onContentUpdate = vi.fn();

      useSseUpdates({
        onContentUpdate,
        getCurrentPath: () => "docs/readme.md",
        getCurrentContentType: () => "markdown",
        onTreeUpdate: vi.fn(),
      });

      const { onFileChanged } = getSseCallbacks();
      onFileChanged(slash("other/file.md"));

      expect(onContentUpdate).not.toHaveBeenCalled();
      expect(fetchContent).not.toHaveBeenCalled();
    });

    it("treats a backslash as part of a file name, not as a separator", () => {
      const onContentUpdate = vi.fn();

      useSseUpdates({
        onContentUpdate,
        getCurrentPath: () => "docs/readme.md",
        getCurrentContentType: () => "markdown",
        onTreeUpdate: vi.fn(),
      });

      const { onFileChanged } = getSseCallbacks();
      onFileChanged(slash("docs\\readme.md"));

      expect(onContentUpdate).not.toHaveBeenCalled();
      expect(fetchContent).not.toHaveBeenCalled();
    });
  });

  describe("file mode", () => {
    it("always calls fetchContent with signal and without path argument", async () => {
      const onContentUpdate = vi.fn();

      useSseUpdates({
        onContentUpdate,
      });

      const { onFileChanged } = getSseCallbacks();
      onFileChanged(slash("any/file.md"));

      await vi.waitFor(() => {
        expect(fetchContent).toHaveBeenCalledWith(undefined, {
          signal: expect.any(AbortSignal),
        });
        expect(onContentUpdate).toHaveBeenCalledWith("<p>content</p>");
      });
    });
  });

  describe("tree updates", () => {
    it("registers onTreeChanged when onTreeUpdate is provided", async () => {
      const onTreeUpdate = vi.fn();
      const treeData = [
        {
          name: "readme.md",
          path: slash("readme.md"),
          type: "file" as const,
        },
      ];
      vi.mocked(fetchTree).mockResolvedValue(treeData);

      useSseUpdates({
        onContentUpdate: vi.fn(),
        getCurrentPath: () => "readme.md",
        getCurrentContentType: () => "markdown",
        onTreeUpdate,
      });

      const { onTreeChanged } = getSseCallbacks();
      expect(onTreeChanged).toBeDefined();

      onTreeChanged?.();

      await vi.waitFor(() => {
        expect(fetchTree).toHaveBeenCalledWith({
          signal: expect.any(AbortSignal),
        });
        expect(onTreeUpdate).toHaveBeenCalledWith(treeData);
      });
    });

    it("does not register onTreeChanged when onTreeUpdate is not provided", () => {
      useSseUpdates({
        onContentUpdate: vi.fn(),
      });

      const { onTreeChanged } = getSseCallbacks();
      expect(onTreeChanged).toBeUndefined();
    });

    it("does not call onTreeUpdate when fetchTree returns null", async () => {
      const onTreeUpdate = vi.fn();
      vi.mocked(fetchTree).mockResolvedValue(null);

      useSseUpdates({
        onContentUpdate: vi.fn(),
        getCurrentPath: () => "readme.md",
        getCurrentContentType: () => "markdown",
        onTreeUpdate,
      });

      const { onTreeChanged } = getSseCallbacks();
      onTreeChanged?.();

      await vi.waitFor(() => {
        expect(fetchTree).toHaveBeenCalled();
      });
      expect(onTreeUpdate).not.toHaveBeenCalled();
    });
  });

  describe("abort behavior", () => {
    it("aborts previous fetchContent when a new file-changed event fires", async () => {
      const onContentUpdate = vi.fn();
      let resolveFirst: ((v: string | null) => void) | undefined;
      const firstPromise = new Promise<string | null>((r) => {
        resolveFirst = r;
      });
      vi.mocked(fetchContent)
        .mockReturnValueOnce(firstPromise)
        .mockResolvedValueOnce("<p>second</p>");

      useSseUpdates({
        onContentUpdate,
      });

      const { onFileChanged } = getSseCallbacks();
      // First event starts a fetch
      onFileChanged(slash("file.md"));
      // Second event should abort the first
      onFileChanged(slash("file.md"));

      // Resolve the first (should be ignored since aborted)
      resolveFirst?.("<p>first</p>");

      await vi.waitFor(() => {
        expect(fetchContent).toHaveBeenCalledTimes(2);
        expect(onContentUpdate).toHaveBeenCalledWith("<p>second</p>");
      });
    });

    it("does not call onContentUpdate when fetchContent returns null", async () => {
      const onContentUpdate = vi.fn();
      vi.mocked(fetchContent).mockResolvedValue(null);

      useSseUpdates({
        onContentUpdate,
      });

      const { onFileChanged } = getSseCallbacks();
      onFileChanged(slash("file.md"));

      await vi.waitFor(() => {
        expect(fetchContent).toHaveBeenCalled();
      });
      expect(onContentUpdate).not.toHaveBeenCalled();
    });

    it("logs error when fetchContent rejects with non-abort error", async () => {
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      vi.mocked(fetchContent).mockRejectedValue(new Error("network failure"));

      useSseUpdates({
        onContentUpdate: vi.fn(),
      });

      const { onFileChanged } = getSseCallbacks();
      onFileChanged(slash("file.md"));

      await vi.waitFor(() => {
        expect(consoleSpy).toHaveBeenCalledWith(
          "[peek] Failed to refresh content:",
          expect.any(Error),
        );
      });
      consoleSpy.mockRestore();
    });

    it("silently ignores AbortError from fetchContent", async () => {
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const abortError = new DOMException(
        "The operation was aborted",
        "AbortError",
      );
      vi.mocked(fetchContent).mockRejectedValue(abortError);

      useSseUpdates({
        onContentUpdate: vi.fn(),
      });

      const { onFileChanged } = getSseCallbacks();
      onFileChanged(slash("file.md"));

      // Give time for the promise to settle
      await new Promise((r) => setTimeout(r, 10));
      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });
});
