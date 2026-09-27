import { describe, expect, it } from "vitest";
import { createHtmlFileRoutes } from "./html-file.js";

describe("html file routes", () => {
  it("GET / returns HTML document with iframe", async () => {
    const app = createHtmlFileRoutes("/tmp/test.html");
    const res = await app.request("/");
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("test.html - peek");
    expect(html).toContain("<iframe");
    expect(html).toContain('src="/__peek/raw/test.html"');
    expect(html).not.toContain("sandbox=");
  });

  it("GET / encodes the file name in the iframe src", async () => {
    const app = createHtmlFileRoutes("/tmp/my page#1.html");
    const res = await app.request("/");
    const html = await res.text();
    expect(html).toContain('src="/__peek/raw/my%20page%231.html"');
  });

  it("GET / includes SSE reload script", async () => {
    const app = createHtmlFileRoutes("/tmp/test.html");
    const res = await app.request("/");
    const html = await res.text();
    expect(html).toContain("EventSource");
    expect(html).toContain("file-changed");
  });
});
