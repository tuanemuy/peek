import type { SlashPath } from "../../core/slash-path.js";

/**
 * Reads the `path` of a `/view` URL (its query or its history state) as a
 * `SlashPath`: the `?path=` of `/view` is `/`-separated by contract, the tree
 * links with `SlashPath`s and the server redirects a Windows `\`-separated
 * one. The value is not checked, since on POSIX a `\` belongs to a file name.
 */
export function readViewPath(path: string): SlashPath {
  return path as SlashPath;
}

export function getFileNameFromPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || path;
}
