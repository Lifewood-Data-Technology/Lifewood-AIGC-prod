import type { ReactNode } from "react";

export type DataListProps = {
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
  toolbar?: ReactNode;
  filters?: ReactNode;
  actions?: ReactNode;
  summary?: ReactNode;
  resultActions?: ReactNode;
  inlineFilters?: boolean;
  pagination?: ReactNode;
};

/** Shared presentation only. Pages retain query timing, selection, permissions and actions. */
export default function DataList({ children, className = "", ariaLabel, toolbar, filters, actions, summary, resultActions, inlineFilters = false, pagination }: DataListProps) {
  return <section className={`data-list ${className}`.trim()} aria-label={ariaLabel}>
    {(toolbar || actions || filters || summary || resultActions) && <div className="data-list-toolbar">
      {(toolbar || actions || (inlineFilters && filters)) && <div className="data-list-primary"><div className="data-list-query"><div className="data-list-search">{toolbar}</div>{inlineFilters && filters && <div className="data-list-filters">{filters}</div>}</div><div className="data-list-actions">{actions}</div></div>}
      {!inlineFilters && filters && <div className="data-list-filters">{filters}</div>}
      {(summary || resultActions) && <div className="data-list-summary"><div className="data-list-summary-content">{summary}</div>{resultActions && <div className="data-list-result-actions">{resultActions}</div>}</div>}
    </div>}
    <div className="data-list-body">{children}</div>
    {pagination && <div className="data-list-pagination">{pagination}</div>}
  </section>;
}

/** Use for existing tables inside a specialised workspace without changing that workspace. */
export function DataListTable({ children, className = "", ariaLabel }: { children: ReactNode; className?: string; ariaLabel?: string }) {
  // A labelled overflow region must be focusable so keyboard users can scroll wide, read-only tables.
  // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
  return <div className={`data-list-scroll ${className}`.trim()} role="region" aria-label={ariaLabel} tabIndex={0}>{children}</div>;
}
