"use client";
import { useEffect, type RefObject } from "react";

/** Legacy modal shells need the same keyboard boundary as native dialogs. */
export default function useDialogFocus(body: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const shell = body.current?.closest<HTMLElement>('[role="dialog"], [role="alertdialog"], dialog');
    if (!shell || shell.tagName === "DIALOG") return;
    const trigger = document.activeElement;
    const originalTabIndex = shell.getAttribute("tabindex");
    shell.tabIndex = -1;
    const controls = () => Array.from(shell.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
    )).filter(node => !node.closest('[hidden], [inert]') && window.getComputedStyle(node).display !== "none" && window.getComputedStyle(node).visibility !== "hidden");
    const active = () => !document.querySelector('dialog[open]') && Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).at(-1) === shell;
    const focusFirst = () => (controls()[0] || shell).focus();
    if (!shell.contains(document.activeElement)) focusFirst();
    const ownedPopup = (target: Node) => Array.from(shell.querySelectorAll('[aria-expanded="true"][aria-controls]')).some(control => {
      const list = document.getElementById(control.getAttribute("aria-controls") || "");
      return !!list?.closest(".select-popup")?.contains(target);
    });
    const contain = (event: FocusEvent) => { if (active() && !shell.contains(event.target as Node) && !ownedPopup(event.target as Node)) focusFirst(); };
    const keys = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !active()) return;
      const items = controls(), first = items[0], last = items.at(-1);
      if (!first) { event.preventDefault(); shell.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === shell)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("focusin", contain);
    document.addEventListener("keydown", keys);
    return () => {
      document.removeEventListener("focusin", contain);
      document.removeEventListener("keydown", keys);
      if (originalTabIndex === null) shell.removeAttribute("tabindex"); else shell.setAttribute("tabindex", originalTabIndex);
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, [body]);
}
