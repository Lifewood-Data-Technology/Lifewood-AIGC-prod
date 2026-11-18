"use client";
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

export const sidebarDrawerQuery = "(max-width: 900px)";

/** Keep the responsive sidebar usable independently of page navigation/draft guards. */
export function useSidebarDrawer(open: boolean, setOpen: Dispatch<SetStateAction<boolean>>, ready: boolean) {
  const [narrow, setNarrow] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const media = window.matchMedia?.(sidebarDrawerQuery);
    const sync = () => {
      const matches = media?.matches ?? window.innerWidth <= 900;
      setNarrow(matches);
      if (!matches) setOpen(false);
    };
    sync();
    if (media) {
      media.addEventListener("change", sync);
      return () => media.removeEventListener("change", sync);
    }
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, [setOpen]);
  useEffect(() => {
    if (!ready || !narrow || !open) return;
    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    const trigger = triggerRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Wait for the open class and inert removal to reach the browser's next frame.
    // Focusing while the drawer is still visibility:hidden silently leaves focus on body.
    const focusFrame = window.requestAnimationFrame(() => {
      if (sidebar.isConnected && !sidebar.hasAttribute("inert") && !sidebar.contains(document.activeElement)) {
        sidebar.querySelector<HTMLButtonElement>(".mobile-close")?.focus({preventScroll:true});
      }
    });
    const keydown = (event: KeyboardEvent) => {
      // A native or nested dialog owns its own escape/keyboard handling.
      if (document.querySelector("dialog[open], .modal-backdrop [role=dialog]")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
      if (event.key !== "Tab") return;
      const focusable = [...sidebar.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), [tabindex='0']")]
        .filter(element => !element.closest("[hidden], [inert]") && element.getClientRects().length > 0);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !sidebar.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !sidebar.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", keydown);
      if (window.matchMedia?.(sidebarDrawerQuery).matches ?? window.innerWidth <= 900) trigger?.focus({preventScroll:true});
    };
  }, [narrow, open, ready, setOpen]);
  return { sidebarRef, triggerRef, narrow, drawerOpen: narrow && open };
}
