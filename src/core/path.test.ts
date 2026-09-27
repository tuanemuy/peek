import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isRelativePathWithinBase, isWithinBase, toSlashPath } from "./path.js";

// The separator `toSlashPath` reads, switched per test to run the Windows
// branch on any host.
const os = vi.hoisted(() => ({ sep: "/" }));

vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return {
    ...actual,
    get sep() {
      return os.sep;
    },
  };
});

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

describe("isRelativePathWithinBase", () => {
  it("returns true for a path inside the base", () => {
    expect(isRelativePathWithinBase("/home/user/docs", "sub/file.md")).toBe(
      true,
    );
  });

  it("returns true when . and .. stay inside the base", () => {
    expect(isRelativePathWithinBase("/home/user/docs", "./a/../b.md")).toBe(
      true,
    );
  });

  it("returns false for a path that climbs above the base", () => {
    expect(isRelativePathWithinBase("/home/user/docs", "../secret.md")).toBe(
      false,
    );
  });

  it("returns false for an absolute path outside the base", () => {
    expect(isRelativePathWithinBase("/home/user/docs", "/etc/passwd")).toBe(
      false,
    );
  });
});

describe("toSlashPath", () => {
  afterEach(() => {
    os.sep = "/";
  });

  describe("on POSIX", () => {
    it("keeps a /-separated path as is", () => {
      expect(toSlashPath("docs/api/ref.md")).toBe("docs/api/ref.md");
    });

    it("keeps a backslash as part of a file name", () => {
      expect(toSlashPath("docs/a\\b.md")).toBe("docs/a\\b.md");
    });
  });

  describe("on Windows", () => {
    beforeEach(() => {
      os.sep = "\\";
    });

    it("replaces every backslash with /", () => {
      expect(toSlashPath("docs\\api\\ref.md")).toBe("docs/api/ref.md");
    });

    it("keeps a /-separated path as is", () => {
      expect(toSlashPath("docs/api/ref.md")).toBe("docs/api/ref.md");
    });
  });
});
