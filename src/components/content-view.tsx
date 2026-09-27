import type { ContentType } from "../core/content-type.js";
import { FULLSCREEN_IFRAME_STYLE } from "../core/iframe-style.js";
import { rawFileUrl } from "../core/url.js";
import { MainContent } from "./layout/main-content.js";
import { MarkdownContent } from "./layout/markdown-content.js";

type ContentViewProps = {
  readonly contentType: ContentType;
  readonly fileTitle: string;
  /** Path of the previewed file, relative to the base directory. */
  readonly filePath: string;
  readonly htmlContent: string;
  readonly htmlReloadKey?: number;
  readonly markdownClass?: string;
};

export function ContentView({
  contentType,
  fileTitle,
  filePath,
  htmlContent,
  htmlReloadKey,
  markdownClass = "px-5 sm:px-10 py-5 sm:py-10",
}: ContentViewProps) {
  if (contentType === "html") {
    return (
      <MainContent class="relative flex-1 overflow-hidden">
        <iframe
          key={htmlReloadKey}
          title={fileTitle}
          src={rawFileUrl(filePath)}
          style={FULLSCREEN_IFRAME_STYLE}
        />
      </MainContent>
    );
  }
  return (
    <MainContent class={markdownClass}>
      <div class="max-w-4xl mx-auto">
        <MarkdownContent htmlContent={htmlContent} />
      </div>
    </MainContent>
  );
}
