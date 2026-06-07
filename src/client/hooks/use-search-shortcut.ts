import { useEffect } from "preact/hooks";

const SEARCH_INPUT_ID = "sidebar-search";

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

/**
 * Focus the sidebar search box when the `/` key is pressed.
 *
 * Ignores the shortcut while an editable element is focused or while an IME
 * composition is in progress. When `onBeforeFocus` is provided (e.g. to open a
 * collapsed sidebar), it runs before focusing the input.
 */
export function useSearchShortcut(onBeforeFocus?: () => void): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "/") return;
      if (event.isComposing) return;
      if (isEditableTarget(event.target)) return;

      event.preventDefault();
      onBeforeFocus?.();
      document.getElementById(SEARCH_INPUT_ID)?.focus();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onBeforeFocus]);
}
