import { useCallback, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  FILE_TREE_STATE_KEY,
  type FileTreeStateStore,
  getCollapsedSet,
  parseStore,
  purgeExpired,
  serializeStore,
  TTL_MS,
  writeCollapsed,
} from "../lib/file-tree-state.js";

export type FileTreeState = {
  readonly isOpen: (path: string) => boolean;
  readonly toggle: (path: string) => void;
};

export function useFileTreeState(projectId: string): FileTreeState {
  // Always start from an empty collapsed set so that the initial client render
  // matches the SSR markup (all directories expanded). Restoration happens in
  // useLayoutEffect, after mount.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const initialMount = useRef(true);

  // Read the persisted store, guarding against environments where localStorage
  // throws (e.g. private browsing).
  function readStore(): FileTreeStateStore {
    try {
      return parseStore(localStorage.getItem(FILE_TREE_STATE_KEY));
    } catch {
      return {};
    }
  }

  function writeStore(store: FileTreeStateStore): void {
    try {
      localStorage.setItem(FILE_TREE_STATE_KEY, serializeStore(store));
    } catch {
      // Persistence failures are non-fatal; the in-memory state still drives UI.
    }
  }

  // Client-only: useLayoutEffect is safe because this hook is only called from
  // DirectoryApp, which runs exclusively via hydrate() on the client.
  // preact-render-to-string does not execute effects during SSR.
  useLayoutEffect(() => {
    if (!initialMount.current) return;
    initialMount.current = false;

    const now = Date.now();
    const purged = purgeExpired(readStore(), now, TTL_MS);
    // Touch the current project's entry (keep its existing collapsed set) so
    // that lastAccess is refreshed, then persist the purge result.
    const touched = writeCollapsed(
      purged,
      projectId,
      getCollapsedSet(purged, projectId),
      now,
    );
    writeStore(touched);
    setCollapsed(getCollapsedSet(touched, projectId));
  }, [projectId]);

  const toggle = useCallback(
    (path: string) => {
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
        }
        // Re-read the latest store before writing so concurrent updates from
        // other tabs/projects are not clobbered.
        const store = writeCollapsed(readStore(), projectId, next, Date.now());
        writeStore(store);
        return next;
      });
    },
    [projectId],
  );

  const isOpen = useCallback(
    (path: string) => !collapsed.has(path),
    [collapsed],
  );

  return { isOpen, toggle };
}
