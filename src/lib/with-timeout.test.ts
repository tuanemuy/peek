import { describe, expect, it } from "vitest";

import { withTimeout } from "./with-timeout.js";

function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function activeTimerCount(): number {
  return process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
}

describe("withTimeout", () => {
  it("resolves with the value when the promise settles in time", async () => {
    const outcome = await withTimeout(Promise.resolve("done"), 1_000);
    expect(outcome).toEqual({ status: "completed", value: "done" });
  });

  it("resolves as timed-out when the promise never settles", async () => {
    const started = Date.now();
    const outcome = await withTimeout(new Promise<never>(() => {}), 50);
    expect(outcome).toEqual({ status: "timed-out" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
  });

  it("does not wait for the full budget when the promise settles early", async () => {
    const started = Date.now();
    const outcome = await withTimeout(
      tick(10).then(() => 1),
      5_000,
    );
    expect(outcome).toEqual({ status: "completed", value: 1 });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  /**
   * The test above does *not* cover `clearTimeout`: dropping it changes nothing
   * about when the returned promise settles, it only leaves a ref'd timer
   * behind. Since the timer is deliberately not `unref()`-ed (ADR-001), that
   * leftover is what would delay process teardown, so it has to be observed
   * directly.
   *
   * The budget is far longer than the run, so any timer that is not cleared is
   * still pending at the assertion. Measured on the current implementation:
   * delta 0. Dropping `clearTimeout` on the fulfilled path, the rejected path,
   * or both makes the delta 5, 5 or 10 respectively — the tolerance below
   * (`< rounds`) catches every one of them while leaving room for unrelated
   * timers the runtime may create meanwhile.
   */
  it("leaves no pending timer behind when the promise settles inside the budget", async () => {
    const budgetMs = 600_000;
    const rounds = 5;
    const before = activeTimerCount();

    for (let i = 0; i < rounds; i++) {
      const fulfilled = await withTimeout(Promise.resolve(i), budgetMs);
      expect(fulfilled).toEqual({ status: "completed", value: i });

      await expect(
        withTimeout(Promise.reject(new Error("boom")), budgetMs),
      ).rejects.toThrow("boom");
    }

    expect(activeTimerCount() - before).toBeLessThan(rounds);
  });

  it("treats a zero budget as always timed out, regardless of settle order", async () => {
    for (let i = 0; i < 20; i++) {
      const alreadyResolved = await withTimeout(Promise.resolve(i), 0);
      expect(alreadyResolved).toEqual({ status: "timed-out" });

      const nextTickResolved = await withTimeout(
        new Promise<number>((resolve) => {
          process.nextTick(() => resolve(i));
        }),
        0,
      );
      expect(nextTickResolved).toEqual({ status: "timed-out" });
    }
  });

  it("treats NaN as a zero budget", async () => {
    const outcome = await withTimeout(Promise.resolve("ignored"), Number.NaN);
    expect(outcome).toEqual({ status: "timed-out" });
  });

  it("passes a rejection through when the promise rejects in time", async () => {
    const error = new Error("boom");
    await expect(withTimeout(Promise.reject(error), 1_000)).rejects.toBe(error);
  });

  it("does not produce an unhandled rejection when the promise rejects after timing out", async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const late = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("late")), 30);
      });
      const outcome = await withTimeout(late, 5);
      expect(outcome).toEqual({ status: "timed-out" });

      const zeroBudget = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("late, zero budget")), 30);
      });
      const zeroOutcome = await withTimeout(zeroBudget, 0);
      expect(zeroOutcome).toEqual({ status: "timed-out" });

      await tick(80);
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
