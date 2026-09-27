import { beforeAll, describe, expect, it } from "vitest";
import { initMarkdown, renderMarkdown } from "./markdown.js";

describe("initMarkdown guard", () => {
  it("throws when renderMarkdown is called before initMarkdown", async () => {
    await expect(renderMarkdown("# test", "README.md")).rejects.toThrow(
      /not initialized/,
    );
  });

  it("is idempotent — calling initMarkdown twice does not throw", async () => {
    await expect(initMarkdown()).resolves.toBeUndefined();
    await expect(initMarkdown()).resolves.toBeUndefined();
  });
});

describe("renderMarkdown", () => {
  beforeAll(async () => {
    await initMarkdown();
  });

  it("renders headings", async () => {
    const html = await renderMarkdown("# Hello World", "README.md");
    expect(html).toContain("<h1>");
    expect(html).toContain("Hello World");
  });

  it("renders paragraphs", async () => {
    const html = await renderMarkdown("This is a paragraph.", "README.md");
    expect(html).toContain("<p>");
    expect(html).toContain("This is a paragraph.");
  });

  it("renders unordered lists", async () => {
    const html = await renderMarkdown(
      "- item 1\n- item 2\n- item 3",
      "README.md",
    );
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>");
    expect(html).toContain("item 1");
  });

  it("renders ordered lists", async () => {
    const html = await renderMarkdown("1. first\n2. second", "README.md");
    expect(html).toContain("<ol>");
    expect(html).toContain("first");
  });

  it("renders code blocks with syntax highlighting", async () => {
    const html = await renderMarkdown(
      "```js\nconsole.log('hi');\n```",
      "README.md",
    );
    expect(html).toContain("<pre");
    expect(html).toContain("shiki");
    expect(html).toContain("console");
  });

  it("renders inline code", async () => {
    const html = await renderMarkdown("Use `const` keyword", "README.md");
    expect(html).toContain("<code>");
    expect(html).toContain("const");
  });

  it("renders links", async () => {
    const html = await renderMarkdown(
      "[Google](https://google.com)",
      "README.md",
    );
    expect(html).toContain("<a");
    expect(html).toContain("https://google.com");
    expect(html).toContain("Google");
  });

  it("renders bold text", async () => {
    const html = await renderMarkdown("**bold text**", "README.md");
    expect(html).toContain("<strong>");
    expect(html).toContain("bold text");
  });

  it("renders tables", async () => {
    const md = "| A | B |\n|---|---|\n| 1 | 2 |";
    const html = await renderMarkdown(md, "README.md");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>");
    expect(html).toContain("<td>");
  });

  it("renders strikethrough", async () => {
    const html = await renderMarkdown("~~deleted~~", "README.md");
    expect(html).toContain("<s>");
    expect(html).toContain("deleted");
  });

  it("renders task lists", async () => {
    const html = await renderMarkdown("- [x] done\n- [ ] todo", "README.md");
    expect(html).toContain('type="checkbox"');
  });

  it("handles empty string", async () => {
    const html = await renderMarkdown("", "README.md");
    expect(html).toBe("");
  });
});

describe("renderMarkdown - image paths", () => {
  beforeAll(async () => {
    await initMarkdown();
  });

  it("rewrites a relative image against the Markdown file's directory", async () => {
    const html = await renderMarkdown("![logo](./img.png)", "docs/page.md");
    expect(html).toContain('<img src="/__peek/raw/docs/img.png" alt="logo">');
  });

  it("rewrites a reference-style image", async () => {
    const html = await renderMarkdown(
      "![logo][ref]\n\n[ref]: ../img.png",
      "docs/sub/page.md",
    );
    expect(html).toContain('<img src="/__peek/raw/docs/img.png" alt="logo">');
  });

  it("keeps the query and the hash of a relative image", async () => {
    const html = await renderMarkdown("![](img.png?v=1#x)", "page.md");
    expect(html).toContain('src="/__peek/raw/img.png?v=1#x"');
  });

  it("does not double-encode a path markdown-it has percent-encoded", async () => {
    const html = await renderMarkdown("![](<my img.png>)", "my docs/page.md");
    expect(html).toContain('src="/__peek/raw/my%20docs/my%20img.png"');
  });

  it.each([
    "https://example.com/img.png",
    "//cdn.example.com/img.png",
    "/assets/img.png",
  ])("leaves the absolute image URL %s unchanged", async (src) => {
    const html = await renderMarkdown(`![](${src})`, "docs/page.md");
    expect(html).toContain(`src="${src}"`);
  });

  it("does not rewrite link targets", async () => {
    const html = await renderMarkdown("[other](./other.md)", "docs/page.md");
    expect(html).toContain('href="./other.md"');
  });

  it("uses the path of each render when renders run concurrently", async () => {
    const [a, b] = await Promise.all([
      renderMarkdown("![](img.png)", "a/page.md"),
      renderMarkdown("![](img.png)", "b/page.md"),
    ]);
    expect(a).toContain('src="/__peek/raw/a/img.png"');
    expect(b).toContain('src="/__peek/raw/b/img.png"');
  });
});
