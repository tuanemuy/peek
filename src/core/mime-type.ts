import { getExtension } from "./content-type.js";

export const SVG_MIME_TYPE = "image/svg+xml";

/**
 * Extensions that `/__peek/raw/` may serve, mapped to their `Content-Type`.
 * Anything absent is refused, which keeps `--host 0.0.0.0` from exposing
 * arbitrary files under the base directory.
 */
const MIME_TYPE_MAP: ReadonlyMap<string, string> = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".svg", SVG_MIME_TYPE],
  [".avif", "image/avif"],
  [".ico", "image/x-icon"],
  [".bmp", "image/bmp"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".otf", "font/otf"],
  [".html", "text/html; charset=utf-8"],
  [".htm", "text/html; charset=utf-8"],
]);

export function getMimeType(filePath: string): string | null {
  return MIME_TYPE_MAP.get(getExtension(filePath)) ?? null;
}
