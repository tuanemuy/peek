import { tasklist } from "@mdit/plugin-tasklist";
import { fromAsyncCodeToHtml } from "@shikijs/markdown-it/async";
import type { RendererRule } from "markdown-it";
import createMarkdownItAsync, { type MarkdownItAsync } from "markdown-it-async";
import { codeToHtml } from "shiki";
import { resolveMarkdownImageSrc } from "../core/url.js";

/**
 * Per-render data passed through markdown-it's `env`. The instance is shared
 * by every request, so request-specific data must not live on it.
 */
type RenderEnv = {
  /** Path of the Markdown file, relative to the base directory. */
  readonly markdownPath: string;
};

let md: MarkdownItAsync | null = null;
let initPromise: Promise<void> | null = null;

function withResolvedImageSrc(defaultRule: RendererRule): RendererRule {
  return (tokens, idx, options, env: RenderEnv, self) => {
    const token = tokens[idx];
    const src = token?.attrGet("src");
    if (token && src) {
      token.attrSet("src", resolveMarkdownImageSrc(src, env.markdownPath));
    }
    return defaultRule(tokens, idx, options, env, self);
  };
}

export function initMarkdown(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const instance = createMarkdownItAsync();
      instance.use(tasklist);
      instance.use(
        fromAsyncCodeToHtml(codeToHtml, {
          themes: {
            light: "vitesse-light",
            dark: "vitesse-dark",
          },
          defaultColor: false,
        }),
      );
      const defaultImageRule = instance.renderer.rules.image;
      if (!defaultImageRule) {
        throw new Error("markdown-it has no default image render rule");
      }
      instance.renderer.rules.image = withResolvedImageSrc(defaultImageRule);
      md = instance;
    })().catch((e: unknown) => {
      initPromise = null;
      throw e;
    });
  }
  return initPromise;
}

/**
 * Renders `content`, rewriting relative image paths against `markdownPath`
 * (the file's path relative to the base directory) so that they load through
 * `/__peek/raw/`.
 */
export async function renderMarkdown(
  content: string,
  markdownPath: string,
): Promise<string> {
  if (!md) {
    throw new Error(
      "Markdown renderer not initialized. Call initMarkdown() first.",
    );
  }
  if (content === "") return "";
  const env: RenderEnv = { markdownPath };
  return md.renderAsync(content, env);
}
