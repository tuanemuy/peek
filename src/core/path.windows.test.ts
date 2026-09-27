import { describe, expect, it, vi } from "vitest";
import { toSlashPath } from "./path.js";

vi.mock("node:path", async () => {
  const actual = await vi.importActual<typeof import("node:path")>("node:path");
  return { ...actual, sep: "\\" };
});

describe("toSlashPath with Windows separators", () => {
  it("replaces every backslash with /", () => {
    expect(toSlashPath("docs\\api\\ref.md")).toBe("docs/api/ref.md");
  });

  it("keeps a /-separated path as is", () => {
    expect(toSlashPath("docs/api/ref.md")).toBe("docs/api/ref.md");
  });
});
