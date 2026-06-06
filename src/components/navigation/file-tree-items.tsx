import type { FileTreeNode } from "../../core/file-tree.js";
import { ChevronDownIcon, FileIcon, FolderIcon } from "../icons/index.js";

const MAX_DEPTH = 20;

type FileTreeItemsProps = {
  readonly nodes: readonly FileTreeNode[];
  readonly currentPath?: string;
  readonly depth?: number;
  readonly isOpen?: (path: string) => boolean;
  readonly onToggle?: (path: string) => void;
};

function DirectoryItem({
  node,
  currentPath,
  depth,
  isOpen,
  onToggle,
}: {
  readonly node: FileTreeNode;
  readonly currentPath?: string;
  readonly depth: number;
  readonly isOpen?: (path: string) => boolean;
  readonly onToggle?: (path: string) => void;
}) {
  const open = isOpen ? isOpen(node.path) : true;

  return (
    <li class={depth === 0 ? "px-2 lg:px-5" : ""}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onToggle?.(node.path)}
        class="flex items-center gap-x-3 w-full py-2 px-3 text-left text-sm text-sidebar-foreground hover:bg-sidebar-accent rounded-lg overflow-hidden"
      >
        <FolderIcon class="shrink-0 size-4" />
        <span class="min-w-0 truncate">{node.name}</span>
        <ChevronDownIcon
          class={`${open ? "" : "-rotate-180 "}shrink-0 size-3.5 ms-auto transition-transform`}
        />
      </button>
      {open && (
        <ul class="ps-7 mt-1 flex flex-col gap-y-1 relative before:absolute before:top-0 before:start-[1.125rem] before:w-px before:h-full before:bg-sidebar-border">
          {node.children && depth < MAX_DEPTH ? (
            <FileTreeItems
              nodes={node.children}
              currentPath={currentPath}
              depth={depth + 1}
              isOpen={isOpen}
              onToggle={onToggle}
            />
          ) : null}
        </ul>
      )}
    </li>
  );
}

export function FileTreeItems({
  nodes,
  currentPath,
  depth = 0,
  isOpen,
  onToggle,
}: FileTreeItemsProps) {
  return (
    <>
      {nodes.map((node) => {
        if (node.type === "directory") {
          return (
            <DirectoryItem
              key={node.path}
              node={node}
              currentPath={currentPath}
              depth={depth}
              isOpen={isOpen}
              onToggle={onToggle}
            />
          );
        }

        const isActive = currentPath === node.path;
        return (
          <li key={node.path} class={depth === 0 ? "px-2 lg:px-5" : ""}>
            <a
              href={`/view?path=${encodeURIComponent(node.path)}`}
              class={`flex items-center gap-x-3 py-2 px-3 text-sm rounded-lg overflow-hidden ${
                isActive
                  ? "bg-sidebar-accent text-sidebar-primary font-medium"
                  : "hover:bg-sidebar-accent text-sidebar-foreground"
              }`}
            >
              <FileIcon class="shrink-0 size-4" />
              <span class="min-w-0 truncate">{node.name}</span>
            </a>
          </li>
        );
      })}
    </>
  );
}
