import type { ContentType } from "./content-type.js";
import type { FileTreeNode } from "./file-tree.js";

export type DirectoryInitialState = {
  readonly mode: "directory";
  readonly projectId: string;
  readonly dirTitle: string;
  readonly currentPath: string;
  readonly contentType: ContentType;
  readonly content: string;
  readonly tree: readonly FileTreeNode[];
};

/**
 * Initial state for single-file preview mode.
 *
 * In file mode only one file is rendered, so no path, tree, or title
 * information is needed — the server already knows which file to serve.
 */
export type FileInitialState = {
  readonly mode: "file";
  readonly content: string;
};

export type InitialState = DirectoryInitialState | FileInitialState;
