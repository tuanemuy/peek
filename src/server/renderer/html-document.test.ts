import { describe, expect, it } from "vitest";
import {
  SSE_INITIAL_RETRY_MS,
  SSE_MAX_RETRIES,
  SSE_MAX_RETRY_MS,
} from "../../core/sse-constants.js";
import { renderHtmlDocument } from "./html-document.js";

describe("renderHtmlDocument", () => {
  it("renders a complete HTML document with DOCTYPE", () => {
    const html = renderHtmlDocument("My Page", "/__peek/raw/test.html");
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain("<title>My Page - peek</title>");
  });

  it("renders iframe with correct src and id attributes", () => {
    const html = renderHtmlDocument("test", "/__peek/raw/hello.html");
    expect(html).toContain('src="/__peek/raw/hello.html"');
    expect(html).toContain('id="content-frame"');
  });

  it("escapes special characters in title", () => {
    const html = renderHtmlDocument(
      '<script>alert("xss")</script>',
      "/__peek/raw/test.html",
    );
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script>");
    expect(html).toContain("&quot;xss&quot;");
  });

  it("throws for rawContentUrl not starting with /", () => {
    expect(() => renderHtmlDocument("test", "http://evil.com")).toThrow(
      "rawContentUrl must be an absolute path",
    );
    expect(() => renderHtmlDocument("test", "relative/path")).toThrow(
      "rawContentUrl must be an absolute path",
    );
  });

  describe("SSE reload script", () => {
    it("contains exponential backoff parameters from shared constants", () => {
      const html = renderHtmlDocument("test", "/__peek/raw/test.html");
      expect(html).toContain(`maxRetries = ${SSE_MAX_RETRIES}`);
      expect(html).toContain(`initialDelay = ${SSE_INITIAL_RETRY_MS}`);
      expect(html).toContain(`maxDelay = ${SSE_MAX_RETRY_MS}`);
    });

    it("resets retryCount on successful connection via es.onopen", () => {
      const html = renderHtmlDocument("test", "/__peek/raw/test.html");
      expect(html).toContain("es.onopen");
      // Verify retryCount = 0 appears inside the onopen handler
      expect(html).toMatch(
        /es\.onopen\s*=\s*function\s*\(\)\s*\{[^}]*retryCount\s*=\s*0/,
      );
    });

    it("uses exponential delay calculation with Math.pow", () => {
      const html = renderHtmlDocument("test", "/__peek/raw/test.html");
      expect(html).toContain("Math.min");
      expect(html).toContain("Math.pow(2, retryCount - 1)");
    });

    it("stops retrying after maxRetries exceeded", () => {
      const html = renderHtmlDocument("test", "/__peek/raw/test.html");
      expect(html).toContain("if (retryCount > maxRetries) return");
    });

    it("checks getElementById and contentWindow before reload", () => {
      const html = renderHtmlDocument("test", "/__peek/raw/test.html");
      expect(html).toContain('getElementById("content-frame")');
      expect(html).toContain("f.contentWindow");
      // Verify there's a null check (if f && f.contentWindow)
      expect(html).toMatch(/if\s*\(f\s*&&\s*f\.contentWindow\)/);
    });

    it("closes EventSource on error before retrying", () => {
      const html = renderHtmlDocument("test", "/__peek/raw/test.html");
      expect(html).toContain("es.close()");
    });

    it("connects to /sse endpoint", () => {
      const html = renderHtmlDocument("test", "/__peek/raw/test.html");
      expect(html).toContain('EventSource("/sse")');
    });

    it("listens for file-changed events", () => {
      const html = renderHtmlDocument("test", "/__peek/raw/test.html");
      expect(html).toContain('"file-changed"');
    });
  });
});
