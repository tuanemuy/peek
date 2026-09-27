import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { realPathWithinBase } from "./real-path.js";

const fixtureDir = join(import.meta.dirname, "__test_fixture_real_path__");
const baseDir = join(fixtureDir, "base");
const outsideDir = join(fixtureDir, "outside");

beforeAll(() => {
  mkdirSync(join(baseDir, "sub"), { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(baseDir, "sub", "a.md"), "a");
  writeFileSync(join(outsideDir, "b.md"), "b");
  symlinkSync(join(baseDir, "sub", "a.md"), join(baseDir, "inside-link.md"));
  symlinkSync(join(outsideDir, "b.md"), join(baseDir, "outside-link.md"));
  symlinkSync(baseDir, join(fixtureDir, "base-link"));
});

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe("realPathWithinBase", () => {
  it("returns the real path of a regular file", async () => {
    const result = await realPathWithinBase(baseDir, "sub/a.md");
    expect(result).toEqual({ ok: true, value: join(baseDir, "sub", "a.md") });
  });

  it("follows a symlink that stays inside the base", async () => {
    const result = await realPathWithinBase(baseDir, "inside-link.md");
    expect(result).toEqual({ ok: true, value: join(baseDir, "sub", "a.md") });
  });

  it("refuses a symlink that leads outside the base", async () => {
    const result = await realPathWithinBase(baseDir, "outside-link.md");
    expect(result).toEqual({ ok: false, error: { type: "outside-base" } });
  });

  it("refuses an existing file reached through ..", async () => {
    const result = await realPathWithinBase(baseDir, "../outside/b.md");
    expect(result).toEqual({ ok: false, error: { type: "outside-base" } });
  });

  it("accepts files when the base itself is a symlink", async () => {
    const result = await realPathWithinBase(
      join(fixtureDir, "base-link"),
      "sub/a.md",
    );
    expect(result).toEqual({ ok: true, value: join(baseDir, "sub", "a.md") });
  });

  it("reports a missing file as not found", async () => {
    const result = await realPathWithinBase(baseDir, "nope.md");
    expect(result).toEqual({ ok: false, error: { type: "not-found" } });
  });

  it("reports a path under a file as not found", async () => {
    const result = await realPathWithinBase(baseDir, "sub/a.md/child.md");
    expect(result).toEqual({ ok: false, error: { type: "not-found" } });
  });
});
