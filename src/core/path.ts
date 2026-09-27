import { normalize, resolve, sep } from "node:path";
import type { SlashPath } from "./slash-path.js";

export function isWithinBase(base: string, target: string): boolean {
  const resolvedBase = resolve(base);
  const resolvedTarget = resolve(target);
  const prefix = resolvedBase.endsWith(sep) ? resolvedBase : resolvedBase + sep;
  return resolvedTarget === resolvedBase || resolvedTarget.startsWith(prefix);
}

/**
 * Whether `relativePath`, resolved against `base` without touching the file
 * system, stays inside `base`.
 */
export function isRelativePathWithinBase(
  base: string,
  relativePath: string,
): boolean {
  return isWithinBase(base, resolve(base, normalize(relativePath)));
}

/**
 * Rewrites a relative path taken from the OS (`path.relative`, `fs.watch`, a
 * URL typed on Windows) into a `SlashPath`. On POSIX `\` is an ordinary file
 * name character and is kept.
 */
export function toSlashPath(osPath: string): SlashPath {
  return osPath.split(sep).join("/") as SlashPath;
}
