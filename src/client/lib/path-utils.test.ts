import { describe, expect, it } from "vitest";
import { getFileNameFromPath } from "./path-utils.js";

describe("getFileNameFromPath", () => {
  it("extracts the file name from a path", () => {
    expect(getFileNameFromPath("docs/guide/intro.md")).toBe("intro.md");
  });

  it("returns the path itself for a single segment", () => {
    expect(getFileNameFromPath("readme.md")).toBe("readme.md");
  });

  it("extracts the directory name when path has trailing slash", () => {
    expect(getFileNameFromPath("docs/")).toBe("docs");
  });

  it("returns empty string for empty input", () => {
    expect(getFileNameFromPath("")).toBe("");
  });

  it("returns empty string for root slash", () => {
    expect(getFileNameFromPath("/")).toBe("/");
  });
});
