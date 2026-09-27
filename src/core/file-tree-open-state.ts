/**
 * Which directories of the file tree are open.
 *
 * - `expanded`: directories the user opened with a toggle. These are persisted
 *   and restored on the next visit.
 * - `revealed`: ancestors of files that have been displayed, opened so that the
 *   current file is visible. These live only in memory, so the tree does not
 *   accumulate open directories from browsing.
 *
 * A directory is open when it is in either set. Any combination of the two
 * sets is a valid state.
 */
export type FileTreeOpenState = {
  readonly expanded: ReadonlySet<string>;
  readonly revealed: ReadonlySet<string>;
};

/**
 * Directories containing `filePath`, outermost first
 * (`"a/b/c.md"` → `["a", "a/b"]`). Splits on `/`, the separator used by
 * `FileTreeNode.path` and `/view?path=`.
 */
function getAncestorPaths(filePath: string): readonly string[] {
  const segments = filePath.split("/");
  return segments
    .slice(1)
    .map((_, index) => segments.slice(0, index + 1).join("/"));
}

/**
 * State before any persisted state is known: only the ancestors of the
 * displayed file are open. Shared by SSR and the first client render so that
 * hydration sees identical markup.
 */
export function initialOpenState(currentPath: string): FileTreeOpenState {
  return {
    expanded: new Set(),
    revealed: new Set(getAncestorPaths(currentPath)),
  };
}

export function isDirectoryOpen(
  state: FileTreeOpenState,
  path: string,
): boolean {
  return state.expanded.has(path) || state.revealed.has(path);
}

/**
 * Open a closed directory, or close an open one regardless of why it was open.
 *
 * Opening also marks the directory's ancestors as user-expanded: they were
 * open for the user to reach it, and without them a restored directory would
 * stay hidden under a closed parent. Closing leaves descendants untouched so
 * that reopening shows them as they were.
 */
export function toggleDirectory(
  state: FileTreeOpenState,
  path: string,
): FileTreeOpenState {
  if (isDirectoryOpen(state, path)) {
    return {
      expanded: withoutPath(state.expanded, path),
      revealed: withoutPath(state.revealed, path),
    };
  }
  return {
    expanded: new Set([...state.expanded, ...getAncestorPaths(path), path]),
    revealed: state.revealed,
  };
}

/**
 * Open the ancestors of `filePath` without marking them as user-expanded.
 */
export function revealFile(
  state: FileTreeOpenState,
  filePath: string,
): FileTreeOpenState {
  return {
    expanded: state.expanded,
    revealed: new Set([...state.revealed, ...getAncestorPaths(filePath)]),
  };
}

function withoutPath(
  paths: ReadonlySet<string>,
  path: string,
): ReadonlySet<string> {
  const next = new Set(paths);
  next.delete(path);
  return next;
}
