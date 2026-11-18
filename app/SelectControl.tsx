"use client";
import { Children, Fragment, isValidElement, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode, type SelectHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { queryControlAnchor } from "../lib/query-control-anchor";
import { selectPosition } from "../lib/select-position";
import { ChevronIcon, SearchIcon } from "./ControlIcons";

type Option = { value: string; label: string; disabled: boolean };
function optionText(node: ReactNode): string {
  return Children.toArray(node).map(child => isValidElement<{ children?: ReactNode }>(child) ? optionText(child.props.children) : String(child)).join("");
}
export function selectOptions(children: ReactNode, disabled = false): Option[] {
  return Children.toArray(children).flatMap(child => {
    if (!isValidElement<{ children?: ReactNode; value?: string | number; disabled?: boolean; label?: string }>(child)) return [];
    if (child.type === Fragment || child.type === "optgroup") return selectOptions(child.props.children, disabled || Boolean(child.props.disabled));
    if (child.type !== "option") return [];
    const label = child.props.label ?? optionText(child.props.children);
    return [{ value: String(child.props.value ?? label), label, disabled: disabled || Boolean(child.props.disabled) }];
  });
}

/** The native select remains the form/draft source of truth; only its presentation changes. */
export default function SelectControl({ locale = "zh", children, className = "", onChange, value, defaultValue, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { locale?: "zh" | "en" }) {
  const options = selectOptions(children);
  const native = useRef<HTMLSelectElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const id = useId();
  const [localValue, setLocalValue] = useState(String(defaultValue ?? options.find(option => !option.disabled)?.value ?? ""));
  const [open, setOpen] = useState(false);
  const [portalHost, setPortalHost] = useState<Element | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [label, setLabel] = useState("");
  const [colors, setColors] = useState<CSSProperties>({});
  const [position, setPosition] = useState<ReturnType<typeof selectPosition>>();
  const selected = String(value ?? localValue);
  const chosen = options.find(option => option.value === selected) ?? options.find(option => !option.disabled);
  const filtered = options.filter(option => option.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const searchable = options.length > 7;
  const zh = locale === "zh";
  useEffect(() => {
    const element = native.current;
    if (!element) return;
    const labelCopy = element.labels?.[0]?.cloneNode(true) as HTMLElement | undefined;
    labelCopy?.querySelectorAll(".select-control").forEach(node => node.remove());
    // Synchronize the accessible label with its external native form label.
    setLabel(labelCopy?.textContent?.replace(/\s+/g, " ").trim() || "");
    const sync = () => setLocalValue(element.value);
    const reset = () => queueMicrotask(sync);
    element.form?.addEventListener("reset", reset);
    const button = trigger.current;
    const field = button && queryControlAnchor(button);
    const clickField = (event: MouseEvent) => {
      if (!button || button.contains(event.target as Node) || event.target === element) return;
      event.preventDefault();
      button.focus();
      button.click();
    };
    if (field && field !== button) field.addEventListener("click", clickField);
    return () => {
      element.form?.removeEventListener("reset", reset);
      if (field && field !== button) field.removeEventListener("click", clickField);
    };
  }, [locale]);
  useEffect(() => {
    if (!open) return;
    const positionMenu = () => {
      if (trigger.current) setPosition(selectPosition(queryControlAnchor(trigger.current).getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }));
    };
    const outside = (event: PointerEvent) => {
      if (!(trigger.current && queryControlAnchor(trigger.current).contains(event.target as Node)) && !popup.current?.contains(event.target as Node)) setOpen(false);
    };
    const focusOutside = (event: FocusEvent) => {
      if (!(trigger.current && queryControlAnchor(trigger.current).contains(event.target as Node)) && !popup.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", focusOutside);
    if (searchable) search.current?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", positionMenu, true);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", focusOutside);
    };
  }, [open, searchable]);
  useEffect(() => { if (open) popup.current?.querySelector(`[data-option-index="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [active, open]);
  const show = () => {
    if (props.disabled || native.current?.matches(":disabled") || !trigger.current) return;
    const element = native.current;
    setPortalHost(element?.closest("dialog") || document.body);
    const nativeLabel = element?.labels?.[0];
    setLabel(props["aria-label"] || label || nativeLabel?.querySelector("span")?.textContent || (zh ? "选择选项" : "Select an option"));
    setQuery("");
    setActive(Math.max(0, options.findIndex(option => option.value === element?.value)));
    setPosition(selectPosition(queryControlAnchor(trigger.current).getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }));
    const theme = getComputedStyle(trigger.current);
    const semanticTokens = ["--bg", "--surface", "--surface-2", "--sunk", "--line", "--line-soft", "--text", "--muted", "--faint", "--accent", "--accent-2", "--accent-soft", "--ok", "--ok-soft", "--warn", "--warn-soft", "--bad", "--bad-soft", "--presence-offline", "--presence-offline-bg", "--presence-offline-border"];
    setColors({ ...Object.fromEntries(semanticTokens.map(key => [key, theme.getPropertyValue(key)])), colorScheme: theme.colorScheme } as CSSProperties);
    setOpen(true);
  };
  const choose = (option: Option | undefined) => {
    if (!option || option.disabled || !native.current) return;
    native.current.value = option.value;
    native.current.dispatchEvent(new Event("change", { bubbles: true }));
    setOpen(false);
    trigger.current?.focus();
  };
  const keyboard = (event: React.KeyboardEvent) => {
    if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    else if (event.key === "Tab") {
      setOpen(false);
      if (popup.current?.contains(event.target as Node)) {
        event.preventDefault();
        const fields = Array.from(document.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]')).filter(element => element.tabIndex >= 0 && !element.matches(":disabled") && !element.closest('[hidden], [inert]') && !popup.current?.contains(element) && element.getClientRects().length);
        const index = fields.indexOf(trigger.current as HTMLElement);
        (fields[index + (event.shiftKey ? -1 : 1)] || trigger.current)?.focus();
      }
    }
    else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      if (!open) { show(); return; }
      const available = filtered.map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0);
      const current = available.indexOf(active);
      setActive(event.key === "Home" ? available[0] ?? 0 : event.key === "End" ? available.at(-1) ?? 0 : available[(current + (event.key === "ArrowUp" ? -1 : 1) + available.length) % available.length] ?? 0);
    } else if (open && (event.key === "Enter" || (event.key === " " && event.target === trigger.current))) {
      event.preventDefault(); choose(filtered[active]);
    } else if (!open && event.key === "Enter") { event.preventDefault(); show(); }
    else if (open && !searchable && event.key.length === 1) {
      const index = filtered.findIndex(option => !option.disabled && option.label.toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase()));
      if (index >= 0) { event.preventDefault(); setActive(index); }
    }
  };
  if (props.multiple || (props.size && props.size > 1)) return <select {...props} className={className} value={value} defaultValue={defaultValue} onChange={onChange}>{children}</select>;
  return <span className={`select-control ${className}`}>
    <select {...props} ref={native} className="select-native" value={value} defaultValue={defaultValue} tabIndex={-1} aria-hidden="true"
      onFocus={() => trigger.current?.focus()}
      onInvalid={event => { event.preventDefault(); trigger.current?.focus(); trigger.current?.setAttribute("aria-invalid", "true"); }}
      onChange={event => { setLocalValue(event.target.value); trigger.current?.removeAttribute("aria-invalid"); onChange?.(event); }}>{children}</select>
    <button type="button" ref={trigger} className="select-trigger" role="combobox" disabled={props.disabled}
      aria-expanded={open} aria-controls={`${id}-list`} aria-haspopup="listbox" aria-required={props.required}
      aria-label={props["aria-label"] || label || (zh ? "选择" : "Select")} aria-labelledby={props["aria-labelledby"]} aria-describedby={props["aria-describedby"]} aria-invalid={props["aria-invalid"]}
      aria-activedescendant={open ? `${id}-option-${active}` : undefined} onKeyDown={keyboard} onClick={() => open ? setOpen(false) : show()}>
      <span className="select-value">{chosen?.label || (zh ? "暂无选项" : "No options")}</span><ChevronIcon />
    </button>
    {open && position && portalHost && createPortal(<div className="select-popup" ref={popup} style={{ ...position, ...colors }}>
      {searchable && <div className="select-search"><SearchIcon /><input ref={search} value={query} aria-label={zh ? "搜索选项" : "Search options"} placeholder={zh ? "输入关键词搜索…" : "Search options…"} role="combobox" aria-expanded="true" aria-controls={`${id}-list`} aria-activedescendant={`${id}-option-${active}`} onChange={event => { setQuery(event.target.value); setActive(0); }} onKeyDown={keyboard} /></div>}
      <div className="select-options" id={`${id}-list`} role="listbox" aria-label={label || (zh ? "选项" : "Options")}>
        {filtered.map((option, index) => <div key={`${option.value}:${index}`} id={`${id}-option-${index}`} role="option" aria-selected={option.value === selected} aria-disabled={option.disabled} data-option-index={index} data-active={active === index} tabIndex={-1} onPointerDown={event => event.preventDefault()} onClick={() => choose(option)} onKeyDown={keyboard}>
          <span>{option.label}</span>{option.value === selected && <svg className="control-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m5 12 4 4 10-10" /></svg>}
        </div>)}
        {!filtered.length && <p className="select-empty" role="status">{zh ? "没有匹配的选项" : "No matching options"}</p>}
      </div>
    </div>, portalHost)}
  </span>;
}
