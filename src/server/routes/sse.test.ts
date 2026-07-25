import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSseManager } from "./sse.js";

describe("SSE manager", () => {
  it("GET /sse returns SSE content type", async () => {
    const sse = createSseManager();
    const res = await sse.app.request("/sse");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
  });

  it("starts with zero clients", () => {
    const sse = createSseManager();
    expect(sse.clientCount).toBe(0);
  });

  it("shutdown does not throw with no clients", () => {
    const sse = createSseManager();
    expect(() => sse.shutdown()).not.toThrow();
  });

  it("broadcast does not throw with no clients", () => {
    const sse = createSseManager();
    expect(() =>
      sse.broadcast("file-changed", '{"path":"test.md"}'),
    ).not.toThrow();
  });
});

describe("SSE connection lifecycle", () => {
  let sse: ReturnType<typeof createSseManager>;

  afterEach(() => {
    sse.shutdown();
  });

  it("clientCount increases when a client connects", async () => {
    sse = createSseManager();
    expect(sse.clientCount).toBe(0);

    // Initiate SSE connection (non-blocking — response is a stream)
    sse.app.request("/sse");
    // Allow microtask queue to flush so the stream handler registers the client
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(sse.clientCount).toBe(1);
  });

  it("broadcast sends data to connected clients", async () => {
    sse = createSseManager();
    const res = await sse.app.request("/sse");

    // Allow the stream handler to register
    await new Promise((resolve) => setTimeout(resolve, 50));

    sse.broadcast("file-changed", '{"path":"test.md"}');

    // Read partial body — the SSE stream should contain the broadcast event
    const reader = res.body?.getReader();
    if (!reader) throw new Error("No reader");

    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("file-changed");
    reader.cancel();
  });

  it("shutdown resets clientCount to zero and refuses further clients", async () => {
    sse = createSseManager();
    sse.app.request("/sse");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(sse.clientCount).toBeGreaterThan(0);
    sse.shutdown();
    expect(sse.clientCount).toBe(0);

    sse.app.request("/sse");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sse.clientCount).toBe(0);
  });

  it("GET /sse after shutdown responds 503 without starting a stream", async () => {
    sse = createSseManager();
    sse.shutdown();

    const res = await sse.app.request("/sse");
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type") ?? "").not.toContain(
      "text/event-stream",
    );
  });

  it("GET /sse after shutdown does not register a client", async () => {
    sse = createSseManager();
    sse.shutdown();

    await sse.app.request("/sse");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(sse.clientCount).toBe(0);
  });

  it("shutdown ends connected streams without waiting for the keep-alive interval", async () => {
    sse = createSseManager();
    const res = await sse.app.request("/sse");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const reader = res.body?.getReader();
    if (!reader) throw new Error("No reader");

    sse.shutdown();

    // There is no socket on the `app.request` path, so nothing but the
    // per-client abort can end this stream — if it is ever lost, this hangs
    // until the 30s keep-alive tick and fails here.
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => resolve("expired"), 500);
    });
    const outcome = await Promise.race([
      reader.read().then((r) => (r.done ? "eof" : "chunk")),
      expired,
    ]);
    if (timer) clearTimeout(timer);

    expect(outcome).toBe("eof");
  });
});

describe("SSE keep-alive", () => {
  /**
   * Guards against re-introducing a hand-rolled `sleep()` whose abort listener
   * is never removed on normal completion (it piles up one listener per
   * 30s tick, per client).
   *
   * Measured with this exact shape (5 ticks, max listener count per tick):
   * - `node:timers/promises` (current): [1,1,1,1,1], clientCount 1 → pass
   * - hand-rolled leaking `sleep()`:    [2,3,4,5,6], clientCount 1 → fail
   * - handler never reaching the wait:  [0,0,0,0,0], clientCount 0 → fail
   *
   * It proves "at most one abort listener per client", not "no leak after N
   * completed waits" — fake timers do not drive `node:timers/promises`, so the
   * loop parks on its first wait. The absence of the leak itself is covered by
   * the direct measurement recorded in ADR-006.
   */
  it("does not accumulate abort listeners per client", async () => {
    const signals: AbortSignal[] = [];
    const OriginalAbortController = globalThis.AbortController;
    class SpyAbortController extends OriginalAbortController {
      constructor() {
        super();
        signals.push(this.signal);
      }
    }
    globalThis.AbortController = SpyAbortController as typeof AbortController;

    let sse: ReturnType<typeof createSseManager> | undefined;
    try {
      vi.useFakeTimers();
      sse = createSseManager();
      const resPromise = sse.app.request("/sse");
      await vi.advanceTimersByTimeAsync(0);
      const res = await resPromise;

      // Drain the response body so the keep-alive loop actually iterates.
      // Without this, Hono's TransformStream buffers a single write and
      // back-pressure parks the loop after one round, hiding a linear leak.
      const reader = res.body?.getReader();
      // Fail fast rather than silently skipping the drain: without it the test
      // degrades to the weaker pre-drain form (max 2 instead of 1) and can even
      // go false-green if Hono's buffering changes.
      if (!reader)
        throw new Error("No reader — the drain gives this its margin");
      void (async () => {
        try {
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }
        } catch {
          // Stream closed — nothing to drain anymore.
        }
      })();

      const counts: number[] = [];
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(30_000);
        counts.push(
          ...signals.map((s) => getEventListeners(s, "abort").length),
        );
      }

      // Positive controls: `signals` also holds Hono's internal controller
      // (always 0 listeners), so without these an implementation that never
      // reaches the keep-alive wait would pass vacuously with counts of 0.
      expect(signals.length).toBeGreaterThan(0);
      expect(sse.clientCount).toBe(1);
      expect(counts).toContain(1);

      expect(Math.max(...counts)).toBeLessThanOrEqual(1);
    } finally {
      // `delay()` is ref'd and is not driven by fake timers, so abort the
      // client to release the real 30s timer left behind by the loop.
      sse?.shutdown();
      vi.useRealTimers();
      globalThis.AbortController = OriginalAbortController;
    }
  });
});
