import { normalize, resolve, sep } from "node:path";

export function isWithinBase(base: string, target: string): boolean {
  const resolvedBase = resolve(base);
  const resolvedTarget = resolve(target);
  const prefix = resolvedBase.endsWith(sep) ? resolvedBase : resolvedBase + sep;
  return resolvedTarget === resolvedBase || resolvedTarget.startsWith(prefix);
}

/**
 * Resolves `relativePath` against `base` without touching the file system.
 * Returns `null` when the result lies outside `base`.
 */
export function resolveWithinBase(
  base: string,
  relativePath: string,
): string | null {
  const fullPath = resolve(base, normalize(relativePath));
  return isWithinBase(base, fullPath) ? fullPath : null;
}
