import { setTimeout as delay } from "node:timers/promises";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

export type SSEClient = {
  readonly send: (event: string, data: string) => void;
  readonly close: () => void;
};

export type SseManager = {
  readonly app: Hono;
  readonly broadcast: (event: string, data: string) => void;
  /** Terminal operation — see `createSseManager()`. */
  readonly shutdown: () => void;
  readonly clientCount: number;
};

const KEEP_ALIVE_INTERVAL_MS = 30_000;

export function createSseManager(): SseManager {
  const clients = new Set<SSEClient>();
  let shuttingDown = false;

  function broadcast(event: string, data: string): void {
    for (const client of Array.from(clients)) {
      client.send(event, data);
    }
  }

  /**
   * Terminal operation: refuses new `/sse` connections and closes every open
   * one. Raising the flag *before* walking `clients` is what makes this
   * race-free against a request that is registering itself concurrently (see
   * the handler below). Afterwards `broadcast()` is a no-op — the set is empty
   * and no client can be added again.
   */
  function shutdown(): void {
    shuttingDown = true;
    for (const client of clients) {
      client.close();
    }
    clients.clear();
  }

  const app = new Hono();

  app.get("/sse", (c) => {
    // ① Reject early, without creating a stream at all.
    if (shuttingDown) {
      return c.body(null, 503);
    }
    return streamSSE(c, async (stream) => {
      let closed = false;
      const abortController = new AbortController();

      function cleanup() {
        if (!closed) {
          closed = true;
          abortController.abort();
          clients.delete(client);
        }
      }

      const client: SSEClient = {
        send: (event, data) => {
          if (!closed) {
            stream.writeSSE({ event, data }).catch(cleanup);
          }
        },
        close: cleanup,
      };

      clients.add(client);
      stream.onAbort(cleanup);

      // ② Re-check after publishing ourselves. Together with "raise the flag,
      // then walk the set" in shutdown(), neither order can lose a client:
      // whichever synchronous block runs first, the other one sees its effect.
      // Falling into this branch yields HTTP 200 + text/event-stream + an
      // immediate EOF (the response was already handed back), not the 503 of ①.
      if (shuttingDown) {
        cleanup();
        return;
      }

      // Keep connection alive with comment lines
      while (!closed) {
        try {
          await delay(KEEP_ALIVE_INTERVAL_MS, undefined, {
            signal: abortController.signal,
          });
        } catch {
          // AbortSignal interrupts the wait when the connection is closed — expected
          break;
        }
        if (!closed) {
          // No `.catch()`: Hono's `StreamingApi.write()` swallows write errors
          // and always resolves, so a rejection handler here would be dead code.
          await stream.write(": keep-alive\n\n");
        }
      }
    });
  });

  return {
    app,
    broadcast,
    shutdown,
    get clientCount() {
      return clients.size;
    },
  };
}
