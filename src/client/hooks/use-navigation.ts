import { useCallback, useEffect, useRef } from "preact/hooks";
import type { SlashPath } from "../../core/slash-path.js";
import { fetchContent } from "../lib/api-client.js";
import { getFileNameFromPath, readViewPath } from "../lib/path-utils.js";

/**
 * SPA navigation hook for directory mode.
 * Consolidates link-click interception, popstate handling,
 * and initial history state into a single effect.
 */
export function useNavigation(
  onNavigated: (path: SlashPath, html: string) => void,
): (path: SlashPath, pushState: boolean) => void {
  const navControllerRef = useRef<AbortController | null>(null);
  // Ref avoids stale closure — onNavigated identity may change each render
  const onNavigatedRef = useRef(onNavigated);
  onNavigatedRef.current = onNavigated;

  const navigateToFile = useCallback(
    async (path: SlashPath, pushState: boolean) => {
      if (navControllerRef.current) navControllerRef.current.abort();
      const controller = new AbortController();
      navControllerRef.current = controller;

      try {
        const html = await fetchContent(path, { signal: controller.signal });
        if (html === null) return;

        onNavigatedRef.current(path, html);
        document.title = `${getFileNameFromPath(path)} - peek`;

        const newUrl = `/view?path=${encodeURIComponent(path)}`;
        if (pushState) {
          history.pushState({ path }, "", newUrl);
        }
      } catch (e: unknown) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        console.error("[peek] Failed to navigate:", e);
      }
    },
    [],
  );

  useEffect(() => {
    // Set initial history state (one-time)
    const initialPath = new URLSearchParams(window.location.search).get("path");
    if (initialPath) {
      history.replaceState({ path: initialPath }, "");
    }

    // Link click interception
    function handleClick(e: MouseEvent) {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;

      const link = (e.target as Element).closest(
        "a[href]",
      ) as HTMLAnchorElement | null;
      if (!link) return;

      let url: URL;
      try {
        url = new URL(link.href, window.location.origin);
      } catch {
        return;
      }

      if (url.origin !== window.location.origin) return;
      if (url.pathname !== "/view") return;
      const path = url.searchParams.get("path");
      if (!path) return;

      e.preventDefault();
      navigateToFile(readViewPath(path), true);
    }

    // Browser back/forward
    function handlePopstate(e: PopStateEvent) {
      const state = e.state as { path?: string } | null;
      const path =
        state?.path ?? new URLSearchParams(window.location.search).get("path");
      if (path) {
        navigateToFile(readViewPath(path), false);
      } else {
        window.location.reload();
      }
    }

    document.addEventListener("click", handleClick);
    window.addEventListener("popstate", handlePopstate);
    return () => {
      document.removeEventListener("click", handleClick);
      window.removeEventListener("popstate", handlePopstate);
    };
  }, [navigateToFile]);

  return navigateToFile;
}
