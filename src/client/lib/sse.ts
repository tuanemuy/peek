import {
  SSE_INITIAL_RETRY_MS,
  SSE_MAX_RETRIES,
  SSE_MAX_RETRY_MS,
  SSE_STABLE_THRESHOLD_MS,
} from "../../core/sse-constants.js";
import { logger } from "../../lib/logger.js";

function parseFileChangedData(raw: string): { path: string } | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  if (typeof obj.path !== "string") return null;
  return { path: obj.path };
}

export type SseCallbacks = {
  readonly onFileChanged: (changedPath: string | null) => void;
  readonly onTreeChanged?: () => void;
};

export function createSseConnection(callbacks: SseCallbacks): () => void {
  let retryCount = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stableTimer: ReturnType<typeof setTimeout> | null = null;
  let currentSource: EventSource | null = null;

  function connect(): void {
    if (stableTimer) {
      clearTimeout(stableTimer);
      stableTimer = null;
    }

    const evtSource = new EventSource("/sse");
    currentSource = evtSource;

    evtSource.addEventListener("file-changed", (e: MessageEvent) => {
      const parsed = parseFileChangedData(e.data);
      callbacks.onFileChanged(parsed ? parsed.path : null);
    });

    if (callbacks.onTreeChanged) {
      const onTree = callbacks.onTreeChanged;
      evtSource.addEventListener("tree-changed", () => {
        onTree();
      });
    }

    evtSource.onerror = () => {
      evtSource.close();
      currentSource = null;
      if (stableTimer) {
        clearTimeout(stableTimer);
        stableTimer = null;
      }

      retryCount++;
      if (retryCount > SSE_MAX_RETRIES) {
        logger.warn(
          `SSE connection lost after ${SSE_MAX_RETRIES} retries, giving up.`,
        );
        return;
      }

      const delay = Math.min(
        SSE_INITIAL_RETRY_MS * 2 ** (retryCount - 1),
        SSE_MAX_RETRY_MS,
      );
      logger.info(
        `SSE reconnecting in ${delay}ms (${retryCount}/${SSE_MAX_RETRIES})...`,
      );
      retryTimer = setTimeout(connect, delay);
    };

    stableTimer = setTimeout(() => {
      retryCount = 0;
      stableTimer = null;
    }, SSE_STABLE_THRESHOLD_MS);
  }

  connect();

  return () => {
    if (retryTimer) clearTimeout(retryTimer);
    if (stableTimer) clearTimeout(stableTimer);
    if (currentSource) currentSource.close();
  };
}
