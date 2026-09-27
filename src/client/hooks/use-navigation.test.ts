import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hooks reduced to plain values (no DOM): the returned navigate function is
// exercised directly, and the listener-registering effect is not run.
vi.mock("preact/hooks", () => ({
  useCallback: <T>(fn: T) => fn,
  useRef: <T>(initial: T) => ({ current: initial }),
  useEffect: () => {},
}));

vi.mock("../lib/api-client.js", () => ({
  fetchContent: vi.fn(),
}));

const { fetchContent } = await import("../lib/api-client.js");
const { useNavigation } = await import("./use-navigation.js");

const pushState = vi.fn();

beforeEach(() => {
  vi.stubGlobal("document", { title: "" });
  vi.stubGlobal("history", { pushState });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("useNavigation", () => {
  it("reports the path and content of a successful navigation", async () => {
    vi.mocked(fetchContent).mockResolvedValue("<p>c</p>");
    const onNavigated = vi.fn();
    const navigate = useNavigation(onNavigated);

    await navigate("a/b/c.md", true);

    expect(onNavigated).toHaveBeenCalledWith("a/b/c.md", "<p>c</p>");
    expect(pushState).toHaveBeenCalledWith(
      { path: "a/b/c.md" },
      "",
      `/view?path=${encodeURIComponent("a/b/c.md")}`,
    );
  });

  it("reports only the successful navigation when an earlier fetch failed", async () => {
    vi.mocked(fetchContent)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("<p>c</p>");
    const onNavigated = vi.fn();
    const navigate = useNavigation(onNavigated);

    await navigate("m/missing.md", true);
    await navigate("a/b/c.md", true);

    expect(onNavigated.mock.calls).toEqual([["a/b/c.md", "<p>c</p>"]]);
    expect(pushState.mock.calls).toEqual([
      [
        { path: "a/b/c.md" },
        "",
        `/view?path=${encodeURIComponent("a/b/c.md")}`,
      ],
    ]);
  });

  it("reports only the successful navigation when an earlier one was aborted", async () => {
    vi.mocked(fetchContent)
      .mockRejectedValueOnce(new DOMException("aborted", "AbortError"))
      .mockResolvedValueOnce("<p>z</p>");
    const onNavigated = vi.fn();
    const navigate = useNavigation(onNavigated);

    await navigate("a/b/c.md", true);
    await navigate("z/z.md", true);

    expect(onNavigated.mock.calls).toEqual([["z/z.md", "<p>z</p>"]]);
  });
});
