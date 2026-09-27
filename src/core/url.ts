/**
 * Prefix of the route that serves files under the base directory as-is.
 * `__peek` keeps it from colliding with the user's own paths, which
 * directory mode maps straight onto the URL (`/<relative path>`).
 */
export const RAW_FILE_PREFIX = "/__peek/raw/";

const SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:/i;

/** Percent-encodes each `/`-separated segment, keeping the separators. */
export function encodeUrlPath(relativePath: string): string {
  return relativePath.split("/").map(encodeURIComponent).join("/");
}

/** URL under which `/__peek/raw/` serves `relativePath` (relative to the base directory). */
export function rawFileUrl(relativePath: string): string {
  return `${RAW_FILE_PREFIX}${encodeUrlPath(relativePath)}`;
}

/**
 * Rewrites a relative image `src` of the Markdown file at `markdownPath` into
 * an absolute `/__peek/raw/` URL, since the rendered Markdown is embedded in a
 * page whose URL does not contain the file's directory.
 *
 * `src` is expected to be already percent-encoded (markdown-it normalizes it),
 * so it is resolved rather than re-encoded. Absolute URLs, root-relative
 * paths and fragments are returned unchanged.
 */
export function resolveMarkdownImageSrc(
  src: string,
  markdownPath: string,
): string {
  if (
    src === "" ||
    SCHEME_PATTERN.test(src) ||
    src.startsWith("/") ||
    src.startsWith("#")
  ) {
    return src;
  }
  const directory = markdownPath.slice(0, markdownPath.lastIndexOf("/") + 1);
  // The origin is a placeholder: only the path, query and hash are kept.
  const base = new URL(rawFileUrl(directory), "http://peek.invalid");
  const url = new URL(src, base);
  return `${url.pathname}${url.search}${url.hash}`;
}
