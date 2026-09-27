import { describe, expectTypeOf, it } from "vitest";
import { type FileTreeNode, findAncestorPaths } from "./file-tree.js";
import { initialOpenState, revealFile } from "./file-tree-open-state.js";
import type { DirectoryInitialState } from "./initial-state.js";
import { toSlashPath } from "./path.js";
import type { SlashPath } from "./slash-path.js";

// Checked by `pnpm typecheck`: an unconverted string must not type-check where
// a `/`-separated path is required.
describe("SlashPath", () => {
  it("cannot be assigned from a plain string", () => {
    expectTypeOf<string>().not.toExtend<SlashPath>();
  });

  it("is produced by toSlashPath", () => {
    expectTypeOf(toSlashPath).returns.toEqualTypeOf<SlashPath>();
  });

  it("types the paths of the file tree and the displayed file", () => {
    expectTypeOf<FileTreeNode["path"]>().toEqualTypeOf<SlashPath>();
    expectTypeOf<
      DirectoryInitialState["currentPath"]
    >().toEqualTypeOf<SlashPath>();
    expectTypeOf(findAncestorPaths).parameter(1).toEqualTypeOf<SlashPath>();
    expectTypeOf(initialOpenState).parameter(1).toEqualTypeOf<SlashPath>();
    expectTypeOf(revealFile).parameter(2).toEqualTypeOf<SlashPath>();
  });
});
