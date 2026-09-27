import { describe, expect, it } from "vitest";
import { encodeUrlPath, rawFileUrl, resolveMarkdownImageSrc } from "./url.js";

describe("encodeUrlPath", () => {
  it("encodes each segment and keeps the separators", () => {
    expect(encodeUrlPath("my docs/a#b?.md")).toBe("my%20docs/a%23b%3F.md");
  });

  it("encodes non-ASCII and percent signs", () => {
    expect(encodeUrlPath("資料/100%.png")).toBe(
      "%E8%B3%87%E6%96%99/100%25.png",
    );
  });

  it("returns an empty string for an empty path", () => {
    expect(encodeUrlPath("")).toBe("");
  });
});

describe("rawFileUrl", () => {
  it("prefixes the encoded path with /__peek/raw/", () => {
    expect(rawFileUrl("docs/my page.html")).toBe(
      "/__peek/raw/docs/my%20page.html",
    );
  });

  it("returns the prefix itself for an empty path", () => {
    expect(rawFileUrl("")).toBe("/__peek/raw/");
  });
});

describe("resolveMarkdownImageSrc", () => {
  it("resolves a bare file name against the Markdown file's directory", () => {
    expect(resolveMarkdownImageSrc("img.png", "docs/page.md")).toBe(
      "/__peek/raw/docs/img.png",
    );
  });

  it("resolves ./ against the Markdown file's directory", () => {
    expect(resolveMarkdownImageSrc("./img.png", "docs/page.md")).toBe(
      "/__peek/raw/docs/img.png",
    );
  });

  it("resolves against the base directory for a top-level Markdown file", () => {
    expect(resolveMarkdownImageSrc("./img.png", "page.md")).toBe(
      "/__peek/raw/img.png",
    );
  });

  it("resolves ../ to the parent directory", () => {
    expect(resolveMarkdownImageSrc("../img.png", "docs/sub/page.md")).toBe(
      "/__peek/raw/docs/img.png",
    );
  });

  it("resolves a nested relative path", () => {
    expect(resolveMarkdownImageSrc("assets/img.png", "docs/page.md")).toBe(
      "/__peek/raw/docs/assets/img.png",
    );
  });

  it("keeps the query and the hash", () => {
    expect(resolveMarkdownImageSrc("img.png?v=1#x", "docs/page.md")).toBe(
      "/__peek/raw/docs/img.png?v=1#x",
    );
  });

  it("does not re-encode an already percent-encoded src", () => {
    expect(resolveMarkdownImageSrc("my%20img.png", "page.md")).toBe(
      "/__peek/raw/my%20img.png",
    );
  });

  it("encodes the directory of the Markdown file", () => {
    expect(resolveMarkdownImageSrc("img.png", "my docs/資料/page.md")).toBe(
      "/__peek/raw/my%20docs/%E8%B3%87%E6%96%99/img.png",
    );
  });

  it("returns a URL outside /__peek/raw/ when src climbs above the base", () => {
    expect(resolveMarkdownImageSrc("../img.png", "page.md")).toBe(
      "/__peek/img.png",
    );
  });

  it.each([
    "https://example.com/img.png",
    "http://example.com/img.png",
    "data:image/png;base64,AAAA",
    "blob:http://localhost/uuid",
    "HTTPS://EXAMPLE.COM/img.png",
    "//cdn.example.com/img.png",
    "/assets/img.png",
    "#anchor",
    "",
  ])("leaves %j unchanged", (src) => {
    expect(resolveMarkdownImageSrc(src, "docs/page.md")).toBe(src);
  });
});
