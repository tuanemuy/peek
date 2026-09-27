export type ContentType = "markdown" | "html";

const EXTENSION_MAP: ReadonlyMap<string, ContentType> = new Map([
  [".md", "markdown"],
  [".html", "html"],
  [".htm", "html"],
]);

export function getExtension(filePath: string): string {
  const lastSep = Math.max(
    filePath.lastIndexOf("/"),
    filePath.lastIndexOf("\\"),
  );
  const name = lastSep === -1 ? filePath : filePath.slice(lastSep + 1);
  const lastDot = name.lastIndexOf(".");
  if (lastDot === -1 || lastDot === name.length - 1) return "";
  return name.slice(lastDot).toLowerCase();
}

export function getContentType(filePath: string): ContentType | null {
  return EXTENSION_MAP.get(getExtension(filePath)) ?? null;
}

export function isSupportedFile(filePath: string): boolean {
  return getContentType(filePath) !== null;
}
