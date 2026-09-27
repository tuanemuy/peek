export const FILE_TREE_STATE_KEY = "file-tree-state";
export const TTL_DAYS = 30;
export const TTL_MS = TTL_DAYS * 24 * 60 * 60 * 1000;

export type ProjectEntry = {
  readonly expanded: readonly string[];
  readonly lastAccess: number;
};

export type FileTreeStateStore = Record<string, ProjectEntry>;

/**
 * Parse the raw localStorage value into a store. Returns an empty store when
 * the value is absent or not valid JSON (defensive against corruption).
 *
 * Each entry is validated structurally: only entries that are objects with a
 * numeric `lastAccess` and an array `expanded` are kept. Non-string elements
 * within `expanded` are dropped. Invalid entries, including the former
 * `collapsed` format, are skipped entirely so that downstream functions
 * (purgeExpired, getExpandedSet) never see malformed data.
 */
export function parseStore(raw: string | null): FileTreeStateStore {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    // Reject null (typeof null === "object"), arrays, and primitives.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const store: FileTreeStateStore = {};
    for (const [projectId, entry] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const { expanded, lastAccess } = entry as {
        expanded?: unknown;
        lastAccess?: unknown;
      };
      if (typeof lastAccess !== "number" || !Array.isArray(expanded)) {
        continue;
      }
      store[projectId] = {
        expanded: expanded.filter((p): p is string => typeof p === "string"),
        lastAccess,
      };
    }
    return store;
  } catch {
    return {};
  }
}

/**
 * Remove entries whose last access is older than `ttlMs`. Pure: returns a new
 * store without mutating the input.
 */
export function purgeExpired(
  store: FileTreeStateStore,
  now: number,
  ttlMs: number,
): FileTreeStateStore {
  const next: FileTreeStateStore = {};
  for (const [projectId, entry] of Object.entries(store)) {
    if (now - entry.lastAccess <= ttlMs) {
      next[projectId] = entry;
    }
  }
  return next;
}

/**
 * Build the set of expanded paths for a project (empty set when absent).
 */
export function getExpandedSet(
  store: FileTreeStateStore,
  projectId: string,
): ReadonlySet<string> {
  return new Set(store[projectId]?.expanded ?? []);
}

/**
 * Return a new store with the given project's expanded set and lastAccess
 * updated. The entry is kept even when the expanded set is empty so that
 * lastAccess (TTL) tracking is preserved.
 */
export function writeExpanded(
  store: FileTreeStateStore,
  projectId: string,
  expanded: ReadonlySet<string>,
  now: number,
): FileTreeStateStore {
  return {
    ...store,
    [projectId]: {
      expanded: Array.from(expanded),
      lastAccess: now,
    },
  };
}

export function serializeStore(store: FileTreeStateStore): string {
  return JSON.stringify(store);
}
