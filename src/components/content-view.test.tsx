import renderToString from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { ContentView } from "./content-view.js";

describe("ContentView", () => {
  it("loads an HTML file into an iframe from its encoded raw URL", () => {
    const html = renderToString(
      <ContentView
        contentType="html"
        fileTitle="a page.html"
        filePath="my docs/a page.html"
        htmlContent=""
      />,
    );
    expect(html).toContain('src="/__peek/raw/my%20docs/a%20page.html"');
    expect(html).toContain('title="a page.html"');
  });

  it("renders Markdown content without an iframe", () => {
    const html = renderToString(
      <ContentView
        contentType="markdown"
        fileTitle="page.md"
        filePath="docs/page.md"
        htmlContent="<p>Hello</p>"
      />,
    );
    expect(html).toContain("<p>Hello</p>");
    expect(html).not.toContain("<iframe");
  });
});
