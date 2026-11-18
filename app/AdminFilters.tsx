import type { ReactNode } from "react";

/** Layout only: each page retains its existing filtering and request logic. */
export default function AdminFilters({ locale, children, actions, summary }: {
  locale: "zh" | "en";
  children: ReactNode;
  actions: ReactNode;
  summary?: ReactNode;
}) {
  return <section className="admin-filters" aria-label={locale === "zh" ? "筛选条件" : "Filters"}>
    <div className="admin-filter-fields">{children}</div>
    <div className="admin-filter-footer"><span className="admin-filter-summary">{summary}</span><div className="admin-filter-actions">{actions}</div></div>
  </section>;
}
