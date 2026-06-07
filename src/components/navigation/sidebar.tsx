import type { FileTreeNode } from "../../core/file-tree.js";
import { FileTree } from "./file-tree.js";

type SidebarProps = {
  readonly title: string;
  readonly tree: readonly FileTreeNode[];
  readonly currentPath: string;
  readonly onClose?: () => void;
  readonly isOpen?: (path: string) => boolean;
  readonly onToggle?: (path: string) => void;
  readonly searchQuery?: string;
  readonly onSearchChange?: (query: string) => void;
  readonly isSearching?: boolean;
};

export function Sidebar({
  title,
  tree,
  currentPath,
  onClose,
  isOpen,
  onToggle,
  searchQuery,
  onSearchChange,
  isSearching,
}: SidebarProps) {
  return (
    <>
      {/* Overlay for mobile sidebar — visibility driven by body[data-sidebar-open] via CSS */}
      <div
        role="none"
        id="sidebar-overlay"
        class="fixed inset-0 z-50 bg-black/50 hidden"
        onClick={onClose}
      />

      {/* Sidebar — translate driven by body[data-sidebar-open] via CSS */}
      <aside
        id="sidebar"
        aria-label="File navigation"
        class="fixed inset-y-0 start-0 z-60 w-72 lg:w-auto overflow-hidden bg-sidebar border-e border-sidebar-border -translate-x-full"
      >
        <div class="relative flex flex-col h-full max-h-full pt-3">
          <header class="h-11.5 ps-5 pe-2 lg:ps-8 flex items-center">
            <a
              href="/"
              class="flex-none text-sm font-semibold text-sidebar-foreground hover:text-sidebar-primary"
            >
              {title}
            </a>
          </header>

          <div class="flex-none px-2 lg:px-5 mt-1.5 mb-1">
            <input
              id="sidebar-search"
              type="search"
              placeholder="Search files…"
              value={searchQuery ?? ""}
              onInput={(e) =>
                onSearchChange?.((e.target as HTMLInputElement).value)
              }
              class="w-full py-1.5 px-3 text-sm text-sidebar-foreground bg-sidebar-accent border border-sidebar-border rounded-lg outline-none focus:border-sidebar-primary placeholder:text-sidebar-foreground/50"
            />
          </div>

          <div class="h-full overflow-x-hidden overflow-y-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-thumb]:rounded-none [&::-webkit-scrollbar-track]:bg-scrollbar-track [&::-webkit-scrollbar-thumb]:bg-scrollbar-thumb">
            <nav class="pb-3 w-full flex flex-col">
              {isSearching && tree.length === 0 ? (
                <p class="px-5 py-3 text-sm text-sidebar-foreground/60">
                  No matches found
                </p>
              ) : (
                <FileTree
                  nodes={tree}
                  currentPath={currentPath}
                  isOpen={isOpen}
                  onToggle={onToggle}
                />
              )}
            </nav>
          </div>
        </div>

        {/* Resize handle */}
        <div
          id="sidebar-resize"
          class="absolute inset-y-0 end-0 w-1 cursor-col-resize hover:bg-sidebar-border hidden lg:block pointer-events-auto"
        />
      </aside>
    </>
  );
}
