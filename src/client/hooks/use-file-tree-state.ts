import { useCallback, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  type FileTreeOpenState,
  initialOpenState,
  isDirectoryOpen,
  revealFile,
  toggleDirectory,
} from "../../core/file-tree-open-state.js";
import {
  FILE_TREE_STATE_KEY,
  type FileTreeStateStore,
  getExpandedSet,
  parseStore,
  purgeExpired,
  serializeStore,
  TTL_MS,
  writeExpanded,
} from "../lib/file-tree-state.js";

export type FileTreeState = {
  readonly isOpen: (path: string) => boolean;
  readonly toggle: (path: string) => void;
};

/**
 * Open state of the file tree for a project. The ancestors of `currentPath`
 * are opened on the first render and again whenever `currentPath` changes.
 */
export function useFileTreeState(
  projectId: string,
  currentPath: string,
): FileTreeState {
  // Start from the same state as the SSR markup (only the ancestors of the
  // displayed file open). Restoration happens in useLayoutEffect, after mount.
  const [state, setState] = useState<FileTreeOpenState>(() =>
    initialOpenState(currentPath),
  );
  const initialMount = useRef(true);
  const revealedPath = useRef(currentPath);

  // Keep a ref in sync with the latest state (same approach as DirectoryApp's
  // currentPathRef) so that callbacks can compute the next state outside of a
  // state updater, keeping the updater pure.
  const stateRef = useRef(state);
  stateRef.current = state;

  function update(next: FileTreeOpenState): void {
    stateRef.current = next;
    setState(next);
  }

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
    const expanded = getExpandedSet(purged, projectId);
    // Rewriting the current project's entry refreshes its lastAccess and
    // persists the purge result.
    writeStore(writeExpanded(purged, projectId, expanded, now));
    update({ ...stateRef.current, expanded });
  }, [projectId]);

  useLayoutEffect(() => {
    if (revealedPath.current === currentPath) return;
    revealedPath.current = currentPath;
    update(revealFile(stateRef.current, currentPath));
  }, [currentPath]);

  const toggle = useCallback(
    (path: string) => {
      const next = toggleDirectory(stateRef.current, path);
      update(next);
      // Re-read the latest store before writing so concurrent updates from
      // other tabs/projects are not clobbered.
      writeStore(
        writeExpanded(readStore(), projectId, next.expanded, Date.now()),
      );
    },
    [projectId],
  );

  const isOpen = useCallback(
    (path: string) => isDirectoryOpen(state, path),
    [state],
  );

  return { isOpen, toggle };
}
