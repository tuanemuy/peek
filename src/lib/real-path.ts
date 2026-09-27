import { realpath } from "node:fs/promises";
import { isWithinBase } from "../core/path.js";
import { err, ok, type Result } from "../core/result.js";
import { isNotFoundError } from "./node-error.js";

export type RealPathWithinBaseError =
  | { readonly type: "outside-base" }
  | { readonly type: "not-found" }
  | { readonly type: "io-error"; readonly cause: unknown };

/**
 * Resolves symlinks in `fullPath` and checks that the real path is still
 * inside the real `base`, so that a symlink cannot lead outside of it.
 */
export async function realPathWithinBase(
  base: string,
  fullPath: string,
): Promise<Result<string, RealPathWithinBaseError>> {
  try {
    const [realBase, realTarget] = await Promise.all([
      realpath(base),
      realpath(fullPath),
    ]);
    return isWithinBase(realBase, realTarget)
      ? ok(realTarget)
      : err({ type: "outside-base" });
  } catch (e: unknown) {
    return err(
      isNotFoundError(e)
        ? { type: "not-found" }
        : { type: "io-error", cause: e },
    );
  }
}
