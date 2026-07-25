/**
 * Bounded waiting for a promise.
 *
 * Lives in `src/lib/` rather than `src/core/` because it schedules a timer,
 * which is a side effect; `src/core/` is reserved for pure logic, types and
 * constants.
 */

export type TimeoutOutcome<T> =
  | { readonly status: "completed"; readonly value: T }
  | { readonly status: "timed-out" };

/**
 * Waits for `promise` for at most `timeoutMs`.
 *
 * - Resolves with `{ status: "completed", value }` when `promise` fulfills in time.
 * - Resolves with `{ status: "timed-out" }` when the budget elapses first.
 * - Rejections of `promise` are passed through as rejections (so a failing
 *   `server.close()` still reaches the caller's error handling).
 *
 * A zero budget (`!(timeoutMs > 0)`, which also covers `NaN`) means "always
 * timed out": the result is `{ status: "timed-out" }` regardless of how or when
 * `promise` settles. This is what makes the timeout branch (and its warning log)
 * deterministically testable — racing against `setTimeout(0)` cannot do that,
 * because a `server.close()` callback always runs before a `setTimeout(0)`
 * macrotask. Callers that expect `withTimeout(p, 0)` to mean "check for an
 * already-completed promise" would be surprised; the only caller is
 * `shutdown()`, whose default budget is `SHUTDOWN_TIMEOUT_MS`.
 * (Implementation note: the zero-budget branch resolves synchronously inside the
 * executor, but delivery to `await` is always via a microtask, so callers cannot
 * observe a difference in synchrony.)
 *
 * The timer is cleared once either side settles, and it is deliberately **not**
 * `unref()`-ed: an unref-ed timer never fires when nothing else keeps the event
 * loop alive, which would silently skip the timeout branch (and its warning);
 * `clearTimeout` alone is what prevents the timer from delaying teardown.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<TimeoutOutcome<T>> {
  if (!(timeoutMs > 0)) {
    // Keep a rejection handler attached so a later rejection is not unhandled.
    promise.catch(() => {});
    return Promise.resolve({ status: "timed-out" });
  }

  return new Promise<TimeoutOutcome<T>>((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve({ status: "timed-out" });
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ status: "completed", value });
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
