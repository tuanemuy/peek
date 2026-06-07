export type FileTreeNode = {
  readonly name: string;
  readonly path: string;
  readonly type: "file" | "directory";
  readonly children?: readonly FileTreeNode[];
};

// Centralized matcher so future enhancements (e.g. matching against the full
// path) only need to change here. Currently matches against the node name.
function matchesQuery(node: FileTreeNode, normalizedQuery: string): boolean {
  return node.name.toLowerCase().includes(normalizedQuery);
}

/**
 * Filter a file tree by a search query, keeping ancestors of matched nodes so
 * that the path to each match stays visible.
 *
 * The query is normalized (trimmed + lower-cased). An empty query returns the
 * input unchanged. Matching is case-insensitive substring matching on the node
 * name. When a directory's own name matches, its whole subtree is kept; when a
 * directory does not match but some descendant does, the directory is kept with
 * its children filtered. Original ordering is preserved (no sorting).
 *
 * This function is pure (no mutation of the input) and depends only on string /
 * array operations, so it is safe to include in the client bundle. The returned
 * array is always new, but when a directory name matches (case A) the input node
 * is shared as-is, producing a partially shared new tree, so callers must not
 * mutate the result tree in place.
 */
export function filterFileTree(
  nodes: readonly FileTreeNode[],
  query: string,
): readonly FileTreeNode[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery === "") {
    return nodes;
  }
  return filterNodes(nodes, normalizedQuery);
}

function filterNodes(
  nodes: readonly FileTreeNode[],
  normalizedQuery: string,
): readonly FileTreeNode[] {
  const result: FileTreeNode[] = [];
  for (const node of nodes) {
    if (node.type === "directory") {
      // Directory name matches → keep the whole subtree.
      if (matchesQuery(node, normalizedQuery)) {
        result.push(node);
        continue;
      }
      // Otherwise keep the directory only if some descendant matches, with its
      // children filtered down to the matching subset.
      const filteredChildren = node.children
        ? filterNodes(node.children, normalizedQuery)
        : [];
      if (filteredChildren.length > 0) {
        result.push({ ...node, children: filteredChildren });
      }
      continue;
    }
    if (matchesQuery(node, normalizedQuery)) {
      result.push(node);
    }
  }
  return result;
}
