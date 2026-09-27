import { describe, expectTypeOf, it } from "vitest";
import type { SlashPath } from "../core/slash-path.js";
import type { FileTreeState } from "./hooks/use-file-tree-state.js";
import type { useNavigation } from "./hooks/use-navigation.js";
import type { useSseUpdates } from "./hooks/use-sse-updates.js";
import { readViewPath } from "./lib/path-utils.js";
import type { SseCallbacks } from "./lib/sse.js";

// Checked by `pnpm typecheck` (tsconfig.client.json): the client reads paths
// as `SlashPath`s at its boundaries and passes them on unchanged.
describe("SlashPath in the client", () => {
  it("is what a /view URL's path is read as", () => {
    expectTypeOf(readViewPath).returns.toEqualTypeOf<SlashPath>();
  });

  it("is the path of a change notification", () => {
    expectTypeOf<SseCallbacks["onFileChanged"]>()
      .parameter(0)
      .toEqualTypeOf<SlashPath | null>();
  });

  it("is the displayed path the live update compares against", () => {
    expectTypeOf<
      NonNullable<Parameters<typeof useSseUpdates>[0]["getCurrentPath"]>
    >().returns.toEqualTypeOf<SlashPath>();
  });

  it("is the path a navigation reports and the tree state takes", () => {
    expectTypeOf<Parameters<typeof useNavigation>[0]>()
      .parameter(0)
      .toEqualTypeOf<SlashPath>();
    expectTypeOf<FileTreeState["reveal"]>()
      .parameter(0)
      .toEqualTypeOf<SlashPath>();
    expectTypeOf<FileTreeState["toggle"]>()
      .parameter(0)
      .toEqualTypeOf<SlashPath>();
    expectTypeOf<FileTreeState["isOpen"]>()
      .parameter(0)
      .toEqualTypeOf<SlashPath>();
  });
});
