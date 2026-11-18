"use client";
import { Children, cloneElement, isValidElement, useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Outside table layout/overflow, but inside the current theme and modal scope. */
export default function RowMenu({ label, children }: { label: string; children: ReactNode }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const focusLast = useRef(false);
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState<Element | null>(null);
  const show = (fromEnd = false) => { focusLast.current = fromEnd; setHost(trigger.current?.closest("dialog") || trigger.current?.closest(".app-shell") || null); setOpen(true); };
  const [position, setPosition] = useState({ left: 0, top: 0, maxHeight: 320 });
  const close = (focus = false) => { setOpen(false); if (focus) trigger.current?.focus(); };
  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const height = Math.min(menu.current.scrollHeight + 2, window.innerHeight - 24, 360);
    const width = menu.current.getBoundingClientRect().width;
    // Layout measurement must be applied before paint to avoid a visible menu jump.
    setPosition({ left: Math.max(12, Math.min(anchor.right - width, window.innerWidth - width - 12)), top: Math.max(12, anchor.bottom + height + 8 <= window.innerHeight - 12 ? anchor.bottom + 8 : anchor.top - height - 8), maxHeight: height });
    const buttons = [...menu.current.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    (focusLast.current ? buttons.at(-1) : buttons[0])?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close(); };
    const scroll = (event: Event) => { if (!menu.current?.contains(event.target as Node)) close(); };
    const resize = () => close();
    document.addEventListener("pointerdown", outside);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", resize);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("scroll", scroll, true); window.removeEventListener("resize", resize); };
  }, [open]);
  return <><button ref={trigger} type="button" className="row-menu-trigger" aria-haspopup="menu" aria-expanded={open} onClick={() => open ? close() : show()} onKeyDown={event => { if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); show(event.key === "ArrowUp"); } }}>{label}</button>
    {open && host && createPortal(<div ref={menu} role="menu" tabIndex={-1} aria-label={label} className="floating-row-menu" style={position} onClick={event => { if ((event.target as Element).closest("button:not(:disabled)")) close(true); }} onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
      if (event.key === "Tab") close();
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault(); const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") || [])];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    }}>{Children.map(children, child => isValidElement(child) ? cloneElement(child as ReactElement<{ role?: string; tabIndex?: number }>, { role: "menuitem", tabIndex: -1 }) : child)}</div>, host)}
  </>;
}
