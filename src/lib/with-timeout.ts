/**
 * Bounded waiting for a promise.
 *
 * Why `src/lib/` and not `src/core/`: see `.issue/102/adr.md` ADR-001.
 */

export type TimeoutOutcome<T> =
  | { readonly status: "completed"; readonly value: T }
  | { readonly status: "timed-out" };

/**
 * Waits for `promise` for at most `timeoutMs`.
 *
 * - `{ status: "completed", value }` — `promise` fulfilled inside the budget.
 * - `{ status: "timed-out" }` — the budget elapsed first.
 * - Rejects only when `promise` rejects *inside* the budget. A rejection after
 *   the budget elapsed (or under a zero budget) is subscribed to so that it is
 *   never unhandled, but it is discarded — nothing reports it.
 *
 * A zero budget (`!(timeoutMs > 0)`, which also covers `NaN`) means "always
 * timed out", whatever `promise` does. That is what makes the timeout branch
 * deterministically testable.
 *
 * The timer is deliberately **not** `unref()`-ed: an unref-ed timer never fires
 * when nothing else keeps the event loop alive, which would silently skip the
 * timeout branch and its warning. See `.issue/102/adr.md` ADR-001.
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
