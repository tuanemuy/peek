import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileTreeNode } from "../core/file-tree.js";

// Hooks reduced to plain values (no DOM): DirectoryApp is called as a function
// to inspect how it wires the navigation callback to the file tree state.
vi.mock("preact/hooks", () => ({
  useState: <T,>(initial: T) => [initial, () => {}],
  useRef: <T,>(initial: T) => ({ current: initial }),
  useMemo: <T,>(fn: () => T) => fn(),
}));

const fileTree = vi.hoisted(() => ({
  isOpen: () => false,
  toggle: () => {},
  reveal: vi.fn(),
}));
const navigation = vi.hoisted(() => ({
  onNavigated: undefined as ((path: string, html: string) => void) | undefined,
}));

vi.mock("./hooks/use-file-tree-state.js", () => ({
  useFileTreeState: vi.fn(() => fileTree),
}));
vi.mock("./hooks/use-navigation.js", () => ({
  useNavigation: (onNavigated: (path: string, html: string) => void) => {
    navigation.onNavigated = onNavigated;
    return () => {};
  },
}));
vi.mock("./hooks/use-search-shortcut.js", () => ({
  useSearchShortcut: () => {},
}));
vi.mock("./hooks/use-sidebar.js", () => ({
  useSidebar: () => ({ open: () => {}, close: () => {}, toggle: () => {} }),
}));
vi.mock("./hooks/use-sse-updates.js", () => ({
  useSseUpdates: () => {},
}));

const { useFileTreeState } = await import("./hooks/use-file-tree-state.js");
const { DirectoryApp } = await import("./directory-app.js");

const tree: readonly FileTreeNode[] = [
  {
    name: "a",
    path: "a",
    type: "directory",
    children: [{ name: "c.md", path: "a/c.md", type: "file" }],
  },
];

function renderApp(): (path: string, html: string) => void {
  DirectoryApp({
    projectId: "p",
    dirTitle: "proj",
    currentPath: "root.md",
    contentType: "markdown",
    content: "",
    tree,
  });
  if (!navigation.onNavigated) throw new Error("useNavigation not called");
  return navigation.onNavigated;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  navigation.onNavigated = undefined;
});

describe("DirectoryApp file tree wiring", () => {
  it("builds the file tree state from the initial tree and path", () => {
    renderApp();

    expect(useFileTreeState).toHaveBeenCalledWith("p", tree, "root.md");
  });

  it("reveals the file of every successful navigation, including the current one", () => {
    const onNavigated = renderApp();

    onNavigated("a/c.md", "<p>c</p>");
    onNavigated("a/c.md", "<p>c</p>");

    expect(fileTree.reveal.mock.calls).toEqual([["a/c.md"], ["a/c.md"]]);
  });

  it("reveals only supported files when an unsupported one is reported", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const onNavigated = renderApp();

    onNavigated("a/image.png", "");
    onNavigated("a/c.md", "<p>c</p>");

    expect(fileTree.reveal.mock.calls).toEqual([["a/c.md"]]);
    expect(error).toHaveBeenCalledWith(
      "Unexpected unsupported file type: a/image.png",
    );
  });
});
