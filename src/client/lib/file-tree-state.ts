export const FILE_TREE_STATE_KEY = "file-tree-state";
export const TTL_DAYS = 30;
export const TTL_MS = TTL_DAYS * 24 * 60 * 60 * 1000;

export type ProjectEntry = {
  readonly collapsed: readonly string[];
  readonly lastAccess: number;
};

export type FileTreeStateStore = Record<string, ProjectEntry>;

/**
 * Parse the raw localStorage value into a store. Returns an empty store when
 * the value is absent or not valid JSON (defensive against corruption).
 *
 * Each entry is validated structurally: only entries that are objects with a
 * numeric `lastAccess` and an array `collapsed` are kept. Non-string elements
 * within `collapsed` are dropped. Invalid entries are skipped entirely so that
 * downstream functions (purgeExpired, getCollapsedSet) never see malformed data.
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
      const { collapsed, lastAccess } = entry as {
        collapsed?: unknown;
        lastAccess?: unknown;
      };
      if (typeof lastAccess !== "number" || !Array.isArray(collapsed)) {
        continue;
      }
      store[projectId] = {
        collapsed: collapsed.filter((p): p is string => typeof p === "string"),
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
 * Build the set of collapsed paths for a project (empty set when absent).
 */
export function getCollapsedSet(
  store: FileTreeStateStore,
  projectId: string,
): Set<string> {
  return new Set(store[projectId]?.collapsed ?? []);
}

/**
 * Return a new store with the given project's collapsed set and lastAccess
 * updated. The entry is kept even when the collapsed set is empty so that
 * lastAccess (TTL) tracking is preserved.
 */
export function writeCollapsed(
  store: FileTreeStateStore,
  projectId: string,
  collapsed: Set<string>,
  now: number,
): FileTreeStateStore {
  return {
    ...store,
    [projectId]: {
      collapsed: Array.from(collapsed),
      lastAccess: now,
    },
  };
}

export function serializeStore(store: FileTreeStateStore): string {
  return JSON.stringify(store);
}
