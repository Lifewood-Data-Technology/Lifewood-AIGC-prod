"use client";
import SelectControl from "./SelectControl";
type Locale = "zh" | "en";
export default function Pagination({
  locale,
  page,
  pageSize,
  total,
  onPage,
  onPageSize,
}: {
  locale: Locale;
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), pages);
  const start = total ? (current - 1) * pageSize + 1 : 0;
  const end = Math.min(total, current * pageSize);
  return (
    <div className="table-pagination" aria-label={locale === "zh" ? "分页" : "Pagination"}>
      <span>
        {locale === "zh"
          ? `第 ${start}–${end} 条，共 ${total} 条`
          : `${start}–${end} of ${total}`}
      </span>
      <label>
        {locale === "zh" ? "每页" : "Rows"}
        <SelectControl locale={locale}
          value={pageSize}
          onChange={(event) => onPageSize(Number(event.target.value))}
        >
          {[10, 20, 50, 100].map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </SelectControl>
      </label>
      <div>
        <button aria-label={locale === "zh" ? "第一页" : "First page"} disabled={current === 1} onClick={() => onPage(1)}>
          «
        </button>
        <button aria-label={locale === "zh" ? "上一页" : "Previous page"} disabled={current === 1} onClick={() => onPage(current - 1)}>
          ‹
        </button>
        <b>
          {current} / {pages}
        </b>
        <button
          aria-label={locale === "zh" ? "下一页" : "Next page"}
          disabled={current === pages}
          onClick={() => onPage(current + 1)}
        >
          ›
        </button>
        <button aria-label={locale === "zh" ? "最后一页" : "Last page"} disabled={current === pages} onClick={() => onPage(pages)}>
          »
        </button>
      </div>
    </div>
  );
}
