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

  it("does not report a navigation whose content could not be fetched", async () => {
    vi.mocked(fetchContent).mockResolvedValue(null);
    const onNavigated = vi.fn();

    await useNavigation(onNavigated)("m/missing.md", true);

    expect(onNavigated).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
  });

  it("does not report an aborted navigation", async () => {
    vi.mocked(fetchContent).mockRejectedValue(
      new DOMException("aborted", "AbortError"),
    );
    const onNavigated = vi.fn();

    await useNavigation(onNavigated)("a/b/c.md", true);

    expect(onNavigated).not.toHaveBeenCalled();
  });
});
