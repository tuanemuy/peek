import type { FileTreeNode } from "../../core/file-tree.js";
import { FileTreeItems } from "./file-tree-items.js";

type FileTreeProps = {
  readonly nodes: readonly FileTreeNode[];
  readonly currentPath?: string;
  readonly isOpen?: (path: string) => boolean;
  readonly onToggle?: (path: string) => void;
};

export function FileTree({
  nodes,
  currentPath,
  isOpen,
  onToggle,
}: FileTreeProps) {
  return (
    <ul id="file-tree" class="flex flex-col gap-y-1">
      <FileTreeItems
        nodes={nodes}
        currentPath={currentPath}
        isOpen={isOpen}
        onToggle={onToggle}
      />
    </ul>
  );
}
