import { createHash } from "node:crypto";
import { resolve } from "node:path";

/**
 * Create a stable, short project identifier from an absolute path.
 *
 * The path is normalized with `path.resolve` so that trailing-slash and other
 * representational differences yield the same identifier. The SHA-256 digest is
 * truncated to the first 16 hex characters (64 bits), which is collision-free
 * for practical purposes and avoids exposing the user's directory structure in
 * the serialized initial state.
 */
export function createProjectId(absolutePath: string): string {
  const normalized = resolve(absolutePath);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}
