import { describe, expect, it } from "vitest";
import { createProjectId } from "./project-id.js";

describe("createProjectId", () => {
  it("is deterministic for the same path", () => {
    expect(createProjectId("/foo/bar")).toBe(createProjectId("/foo/bar"));
  });

  it("returns a 16-character hex string", () => {
    const id = createProjectId("/foo/bar");
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("returns different values for different paths", () => {
    expect(createProjectId("/foo/bar")).not.toBe(createProjectId("/foo/baz"));
  });

  it("normalizes trailing-slash differences to the same value", () => {
    expect(createProjectId("/foo")).toBe(createProjectId("/foo/"));
  });
});
