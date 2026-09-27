/**
 * The separator a `node:path` mocked with `withSwitchableSep` reports.
 * `undefined` keeps the host's own separator.
 *
 * ```ts
 * vi.mock("node:path", async (importOriginal) => {
 *   const { withSwitchableSep } = await import("../test-utils/os-separator.js");
 *   return withSwitchableSep(await importOriginal<typeof import("node:path")>());
 * });
 * ```
 */
export const osSeparator: { value: string | undefined } = { value: undefined };

/** `node:path` whose `sep` follows `osSeparator`. */
export function withSwitchableSep<T extends { readonly sep: string }>(
  actual: T,
): T {
  return {
    ...actual,
    get sep() {
      return osSeparator.value ?? actual.sep;
    },
  };
}
