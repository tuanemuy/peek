import type { SlashPath } from "../core/slash-path.js";

/** A literal `/`-separated path used as test input. */
export function slash(path: string): SlashPath {
  return path as SlashPath;
}
