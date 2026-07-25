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
  /**
   * Terminates the SSE subsystem only, unlike `ServerInstance.shutdown()` which
   * stops the whole server and calls this as one of its steps. Afterwards
   * `/sse` answers 503, `broadcast()` is a no-op, and there is no way back.
   */
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
   * Refuses new `/sse` connections and closes every open one. Raising the flag
   * *before* walking `clients` is what makes this race-free against a request
   * that is registering itself concurrently (see the handler below).
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

      // Subscribe before publishing: `StreamingApi.abort()` only notifies the
      // handlers registered at that moment, so an abort landing between the two
      // would otherwise leave this client in `clients` forever.
      stream.onAbort(cleanup);
      clients.add(client);

      // ② Re-check after publishing ourselves. Together with "raise the flag,
      // then walk the set" in shutdown(), neither order can lose a client:
      // whichever synchronous block runs first, the other one sees its effect.
      // Unreachable today — Hono runs this callback synchronously up to the
      // first `await`, so it cannot interleave with shutdown(). It is kept so
      // the guarantee survives an `await` appearing before `clients.add()`,
      // e.g. if Hono's dispatch becomes asynchronous. Taking this branch yields
      // HTTP 200 + text/event-stream + an immediate EOF rather than the 503 of
      // ①: `streamSSE` fixes status and headers itself, so all that is left to
      // do here is end the stream.
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
