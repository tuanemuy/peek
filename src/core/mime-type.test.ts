import { describe, expect, it } from "vitest";
import { getMimeType } from "./mime-type.js";

describe("getMimeType", () => {
  it.each([
    ["a.png", "image/png"],
    ["a.jpg", "image/jpeg"],
    ["a.jpeg", "image/jpeg"],
    ["a.gif", "image/gif"],
    ["a.webp", "image/webp"],
    ["a.svg", "image/svg+xml"],
    ["a.avif", "image/avif"],
    ["a.ico", "image/x-icon"],
    ["a.bmp", "image/bmp"],
    ["a.css", "text/css; charset=utf-8"],
    ["a.js", "text/javascript; charset=utf-8"],
    ["a.mjs", "text/javascript; charset=utf-8"],
    ["a.woff", "font/woff"],
    ["a.woff2", "font/woff2"],
    ["a.ttf", "font/ttf"],
    ["a.otf", "font/otf"],
    ["a.html", "text/html; charset=utf-8"],
    ["a.htm", "text/html; charset=utf-8"],
  ])("returns the MIME type of %s", (path, expected) => {
    expect(getMimeType(path)).toBe(expected);
  });

  it("is case-insensitive for extensions", () => {
    expect(getMimeType("docs/IMG.PNG")).toBe("image/png");
  });

  it.each([
    "notes.md",
    "data.json",
    "secret.txt",
    ".env",
    "Makefile",
    "video.mp4",
    "img.png.bak",
    "dir.png/file",
  ])("returns null for %s, which is not on the allowlist", (path) => {
    expect(getMimeType(path)).toBeNull();
  });
});
