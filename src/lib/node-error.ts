export function isNodeError(e: unknown): e is NodeJS.ErrnoException {
  return (
    e instanceof Error &&
    "code" in e &&
    typeof e.code === "string" &&
    typeof e.message === "string"
  );
}

const NOT_FOUND_CODES: ReadonlySet<string> = new Set([
  "ENOENT",
  "ENOTDIR",
  "EISDIR",
]);

/**
 * Whether `e` means there is no readable file at the path: it does not exist,
 * a parent segment is a file, or the path is a directory.
 */
export function isNotFoundError(e: unknown): boolean {
  return isNodeError(e) && e.code !== undefined && NOT_FOUND_CODES.has(e.code);
}
