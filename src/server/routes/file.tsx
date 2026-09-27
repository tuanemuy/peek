import { basename } from "node:path";
import { Hono } from "hono";
import { MarkdownContent } from "../../components/layout/markdown-content.js";
import { logger } from "../../lib/logger.js";
import { renderMarkdown } from "../../lib/markdown.js";
import { readTextFile } from "../../lib/read-text-file.js";
import type { ResolvedStyles } from "../../lib/styles.js";
import { Document, renderDocument } from "../renderer/document.js";

export function createFileRoutes(
  filePath: string,
  styles: ResolvedStyles,
): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const result = await readTextFile(filePath);
    if (!result.ok) {
      logger.error("Failed to read file:", result.error);
      return c.text("Failed to read file", 500);
    }
    const title = basename(filePath);
    const html = await renderMarkdown(result.value, title);
    return c.html(
      renderDocument(
        <Document
          title={title}
          styles={styles}
          initialState={{ mode: "file", content: html }}
        >
          <main class="px-2 sm:px-5 py-5 sm:py-15">
            <div class="max-w-4xl mx-auto">
              <MarkdownContent htmlContent={html} />
            </div>
          </main>
        </Document>,
      ),
    );
  });

  return app;
}
