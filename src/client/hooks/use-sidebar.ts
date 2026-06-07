import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "preact/hooks";

const SIDEBAR_STATE_KEY = "sidebar-open";
const SIDEBAR_WIDTH_KEY = "sidebar-width";
const MIN_WIDTH = 200;
const MAX_WIDTH = 480;
const DESKTOP_BREAKPOINT = 1024;

function isDesktop(): boolean {
  return window.innerWidth >= DESKTOP_BREAKPOINT;
}

export type SidebarActions = {
  readonly toggle: () => void;
  readonly close: () => void;
  readonly open: () => void;
};

export function useSidebar(): SidebarActions {
  const [open, setOpen] = useState(false);
  const initialMount = useRef(true);

  // Client-only: useLayoutEffect is safe because useSidebar is only called
  // from DirectoryApp which runs exclusively via hydrate() on the client.
  // preact-render-to-string does not execute effects during SSR.
  useLayoutEffect(() => {
    if (initialMount.current) {
      initialMount.current = false;

      // Restore sidebar width
      const storedWidth = localStorage.getItem(SIDEBAR_WIDTH_KEY);
      if (storedWidth) {
        const width = Number(storedWidth);
        if (width >= MIN_WIDTH && width <= MAX_WIDTH) {
          document.documentElement.style.setProperty(
            "--sidebar-width",
            `${width}px`,
          );
        }
      }

      // Open sidebar on desktop if stored preference says so (default: open)
      if (isDesktop() && localStorage.getItem(SIDEBAR_STATE_KEY) !== "false") {
        // Suppress transitions for initial state
        const els = [
          document.getElementById("sidebar"),
          document.getElementById("header-bar"),
          document.getElementById("main-content"),
        ];
        for (const el of els) {
          if (el) el.style.transition = "none";
        }

        document.body.setAttribute("data-sidebar-open", "");
        void document.body.offsetHeight;

        requestAnimationFrame(() => {
          for (const el of els) {
            if (el) el.style.removeProperty("transition");
          }
        });

        setOpen(true);
      }
      return;
    }

    // Subsequent state changes
    if (open) {
      document.body.setAttribute("data-sidebar-open", "");
    } else {
      document.body.removeAttribute("data-sidebar-open");
    }
  }, [open]);

  // Sidebar resize handle (pointer drag)
  useEffect(() => {
    const handle = document.getElementById("sidebar-resize");
    if (!handle) return;

    function onPointerDown(e: PointerEvent): void {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const sidebar = document.getElementById("sidebar");
      document.body.style.setProperty("user-select", "none");
      sidebar?.style.setProperty("transition", "none");

      function onPointerMove(ev: PointerEvent): void {
        const width = Math.min(Math.max(ev.clientX, MIN_WIDTH), MAX_WIDTH);
        document.documentElement.style.setProperty(
          "--sidebar-width",
          `${width}px`,
        );
      }

      function onPointerEnd(ev: PointerEvent): void {
        handle.releasePointerCapture(ev.pointerId);
        handle.removeEventListener("pointermove", onPointerMove);
        handle.removeEventListener("pointerup", onPointerEnd);
        handle.removeEventListener("pointercancel", onPointerEnd);
        document.body.style.removeProperty("user-select");
        sidebar?.style.removeProperty("transition");

        if (ev.type === "pointerup") {
          const width = Math.min(Math.max(ev.clientX, MIN_WIDTH), MAX_WIDTH);
          localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
        }
      }

      handle.addEventListener("pointermove", onPointerMove);
      handle.addEventListener("pointerup", onPointerEnd);
      handle.addEventListener("pointercancel", onPointerEnd);
    }

    handle.addEventListener("pointerdown", onPointerDown);
    return () => handle.removeEventListener("pointerdown", onPointerDown);
  }, []);

  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      if (isDesktop()) {
        localStorage.setItem(SIDEBAR_STATE_KEY, String(next));
      }
      return next;
    });
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    if (isDesktop()) {
      localStorage.setItem(SIDEBAR_STATE_KEY, "false");
    }
  }, []);

  const openSidebar = useCallback(() => {
    setOpen(true);
    if (isDesktop()) {
      localStorage.setItem(SIDEBAR_STATE_KEY, "true");
    }
  }, []);

  return { toggle, close, open: openSidebar };
}
