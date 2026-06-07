import { useMemo, useRef, useState } from "preact/hooks";
import { ContentView } from "../components/content-view.js";
import { PageHeader } from "../components/layout/page-header.js";
import { Sidebar } from "../components/navigation/sidebar.js";
import type { ContentType } from "../core/content-type.js";
import { getContentType } from "../core/content-type.js";
import { type FileTreeNode, filterFileTree } from "../core/file-tree.js";
import { useFileTreeState } from "./hooks/use-file-tree-state.js";
import { useNavigation } from "./hooks/use-navigation.js";
import { useSearchShortcut } from "./hooks/use-search-shortcut.js";
import { useSidebar } from "./hooks/use-sidebar.js";
import { useSseUpdates } from "./hooks/use-sse-updates.js";
import { getFileNameFromPath } from "./lib/path-utils.js";

type DirectoryAppProps = {
  readonly projectId: string;
  readonly dirTitle: string;
  readonly currentPath: string;
  readonly contentType: ContentType;
  readonly content: string;
  readonly tree: readonly FileTreeNode[];
};

export function DirectoryApp({
  projectId,
  dirTitle,
  currentPath: initialPath,
  contentType: initialContentType,
  content: initialContent,
  tree: initialTree,
}: DirectoryAppProps) {
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [contentType, setContentType] =
    useState<ContentType>(initialContentType);
  const [content, setContent] = useState(initialContent);
  const [tree, setTree] = useState(initialTree);
  const [searchQuery, setSearchQuery] = useState("");
  const [htmlReloadKey, setHtmlReloadKey] = useState(0);
  const currentPathRef = useRef(currentPath);
  // Direct ref assignment — no sync effect needed (Preact has no concurrent rendering)
  currentPathRef.current = currentPath;

  const sidebar = useSidebar();
  const fileTree = useFileTreeState(projectId);

  const isSearching = searchQuery.trim() !== "";
  const filteredTree = useMemo(
    () => filterFileTree(tree, searchQuery),
    [tree, searchQuery],
  );

  useSearchShortcut(sidebar.open);

  useNavigation((path, html) => {
    const ct = getContentType(path);
    if (!ct) {
      console.error(`Unexpected unsupported file type: ${path}`);
      return;
    }
    currentPathRef.current = path;
    setCurrentPath(path);
    setContentType(ct);
    setContent(html);
    setHtmlReloadKey(0);
  });

  const contentTypeRef = useRef(contentType);
  contentTypeRef.current = contentType;

  useSseUpdates({
    getCurrentPath: () => currentPathRef.current,
    getCurrentContentType: () => contentTypeRef.current,
    onContentUpdate: setContent,
    onHtmlReload: () => setHtmlReloadKey((k) => k + 1),
    onTreeUpdate: setTree,
  });

  const fileTitle = getFileNameFromPath(currentPath);
  return (
    <>
      <Sidebar
        title={dirTitle}
        tree={filteredTree}
        currentPath={currentPath}
        onClose={sidebar.close}
        isOpen={isSearching ? () => true : fileTree.isOpen}
        onToggle={isSearching ? undefined : fileTree.toggle}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        isSearching={isSearching}
      />

      <PageHeader
        id="header-bar"
        breadcrumbs={[{ label: dirTitle, href: "/" }, { label: fileTitle }]}
        showSidebarToggle
        onToggleSidebar={sidebar.toggle}
        externalLinkHref={`/${currentPath.split("/").map(encodeURIComponent).join("/")}`}
      />

      <ContentView
        contentType={contentType}
        fileTitle={fileTitle}
        rawUrl={`/api/raw?path=${encodeURIComponent(currentPath)}`}
        htmlContent={content}
        htmlReloadKey={htmlReloadKey}
      />
    </>
  );
}
