import { useEffect } from "preact/hooks";
import type { ContentType } from "../../core/content-type.js";
import type { FileTreeNode } from "../../core/file-tree.js";
import type { SlashPath } from "../../core/slash-path.js";
import { fetchContent, fetchTree } from "../lib/api-client.js";
import { createSseConnection } from "../lib/sse.js";

/**
 * SSE live-update hook.
 *
 * Directory mode: pass `getCurrentPath`, `getCurrentContentType`,
 * `onHtmlReload`, and `onTreeUpdate` to refresh only the active file
 * and tree on server events.
 * File mode: omit all — every file-changed event refreshes content.
 */
export function useSseUpdates(params: {
  readonly onContentUpdate: (html: string) => void;
  readonly getCurrentPath?: () => SlashPath;
  readonly getCurrentContentType?: () => ContentType;
  readonly onHtmlReload?: () => void;
  readonly onTreeUpdate?: (tree: readonly FileTreeNode[]) => void;
}): void {
  // All callbacks are expected to be stable (state setters) or accessed via
  // getCurrentPath / getCurrentContentType (ref-based getters). This allows [] deps safely.
  const {
    onContentUpdate,
    getCurrentPath,
    getCurrentContentType,
    onHtmlReload,
    onTreeUpdate,
  } = params;

  useEffect(() => {
    let contentAbort: AbortController | null = null;
    let treeAbort: AbortController | null = null;

    const cleanup = createSseConnection({
      onFileChanged: (changedPath) => {
        if (getCurrentPath) {
          // Directory mode: only refresh if the changed file matches current
          if (changedPath === null) return;
          const current = getCurrentPath();
          if (changedPath !== current) return;
          // HTML files are served via iframe; just signal a reload
          if (getCurrentContentType?.() === "html") {
            onHtmlReload?.();
            return;
          }
          contentAbort?.abort();
          contentAbort = new AbortController();
          fetchContent(current, { signal: contentAbort.signal })
            .then((html) => {
              if (html !== null) onContentUpdate(html);
            })
            .catch((e: unknown) => {
              if (e instanceof DOMException && e.name === "AbortError") return;
              console.error("[peek] Failed to refresh content:", e);
            });
        } else {
          // File mode: always refresh
          contentAbort?.abort();
          contentAbort = new AbortController();
          fetchContent(undefined, { signal: contentAbort.signal })
            .then((html) => {
              if (html !== null) onContentUpdate(html);
            })
            .catch((e: unknown) => {
              if (e instanceof DOMException && e.name === "AbortError") return;
              console.error("[peek] Failed to refresh content:", e);
            });
        }
      },
      onTreeChanged: onTreeUpdate
        ? () => {
            treeAbort?.abort();
            treeAbort = new AbortController();
            fetchTree({ signal: treeAbort.signal })
              .then((treeData) => {
                if (treeData) onTreeUpdate(treeData);
              })
              .catch((e: unknown) => {
                if (e instanceof DOMException && e.name === "AbortError")
                  return;
                console.error("[peek] Failed to refresh tree:", e);
              });
          }
        : undefined,
    });

    return () => {
      contentAbort?.abort();
      treeAbort?.abort();
      cleanup();
    };
  }, []); // eslint-disable-line -- stable callbacks by design
}
