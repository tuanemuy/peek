import { normalize, resolve, sep } from "node:path";

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
