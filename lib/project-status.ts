/** Presentation vocabulary only; never mutates workflow or delivery records. */
export function projectStatusLabel(value: unknown): string {
  const status = String(value ?? "").trim();
  return status === "待补充资料" ? "待分配" : status === "待交付" ? "待最终确认" : status;
}
export function projectStatusTone(value: unknown): string | undefined {
  return ({
    "待分配": "warn", "制作中": "active", "待质检": "review",
    "质检驳回": "bad", "客户要求修改": "bad", "部分语言待修改": "bad",
    "待客户预览": "customer", "待最终确认": "confirm",
    "已交付": "ok", "已归档": "ok", "已暂停": "neutral", "已终止": "bad",
  } as Record<string, string>)[projectStatusLabel(value)];
}
