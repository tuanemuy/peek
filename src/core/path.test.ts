import { describe, expect, it } from "vitest";
import { isWithinBase, resolveWithinBase } from "./path.js";

describe("isWithinBase", () => {
  it("returns true for a child path", () => {
    expect(isWithinBase("/home/user/docs", "/home/user/docs/file.md")).toBe(
      true,
    );
  });

  it("returns true for a nested child path", () => {
    expect(isWithinBase("/home/user/docs", "/home/user/docs/sub/file.md")).toBe(
      true,
    );
  });

  it("returns false for a parent path", () => {
    expect(isWithinBase("/home/user/docs", "/home/user")).toBe(false);
  });

  it("returns false for path traversal", () => {
    expect(
      isWithinBase("/home/user/docs", "/home/user/docs/../../../etc/passwd"),
    ).toBe(false);
  });

  it("returns true for the base path itself", () => {
    expect(isWithinBase("/home/user/docs", "/home/user/docs")).toBe(true);
  });

  it("returns false for a sibling path with common prefix", () => {
    expect(isWithinBase("/home/user/docs", "/home/user/docs-backup/f.md")).toBe(
      false,
    );
  });

  it("returns false for single .. traversal", () => {
    expect(isWithinBase("/home/user/docs", "/home/user/docs/..")).toBe(false);
  });

  it("returns false for ./../../ traversal", () => {
    expect(
      isWithinBase("/home/user/docs", "/home/user/docs/./../../etc/passwd"),
    ).toBe(false);
  });

  it("returns false for double traversal", () => {
    expect(
      isWithinBase("/home/user/docs", "/home/user/docs/../../etc/passwd"),
    ).toBe(false);
  });

  it("returns true with trailing slash on base", () => {
    expect(isWithinBase("/home/user/docs/", "/home/user/docs/file.md")).toBe(
      true,
    );
  });

  it("returns true with trailing slash on target", () => {
    expect(isWithinBase("/home/user/docs", "/home/user/docs/sub/")).toBe(true);
  });

  it("returns true for path within root", () => {
    expect(isWithinBase("/", "/etc/passwd")).toBe(true);
  });
});

describe("resolveWithinBase", () => {
  it("resolves a relative path against the base", () => {
    expect(resolveWithinBase("/home/user/docs", "sub/file.md")).toBe(
      "/home/user/docs/sub/file.md",
    );
  });

  it("normalizes . and .. that stay inside the base", () => {
    expect(resolveWithinBase("/home/user/docs", "./a/../b.md")).toBe(
      "/home/user/docs/b.md",
    );
  });

  it("returns null for a path that climbs above the base", () => {
    expect(resolveWithinBase("/home/user/docs", "../secret.md")).toBeNull();
  });

  it("returns null for an absolute path outside the base", () => {
    expect(resolveWithinBase("/home/user/docs", "/etc/passwd")).toBeNull();
  });
});
