/** Validate a calendar date without Date's silent overflow to another month. */
export function validCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

export function canCloseProject(tasks: Array<{ status?: unknown }>) {
  return tasks.length > 0 && tasks.every(task => ["已交付", "已归档", "已终止"].includes(String(task.status)));
}

/** Every recorded issue belongs to the reviewed version and blocks approval.
 * Severity describes priority, not permission to ignore a defect. */
export function hasReviewIssues(issues: readonly unknown[]) {
  return issues.length > 0;
}

/** Coarse role/scope checks remain mandatory in each handler. */
export function workflowCapability(action: string) {
  if (action === "project.deliver") return "delivery.manage";
  if (action.startsWith("client.")) return "customers.manage";
  if (action.startsWith("project.") || action.startsWith("showcase.")) return "projects.manage";
  if (action.startsWith("sales.project_request.")) return "requests.create";
  if (action === "sales.customer_feedback") return "delivery.manage";
  if (action.startsWith("production.") || action.startsWith("asset.collection.")) return "files.upload";
  if (action === "quality.review") return "quality.review";
  if (action.startsWith("material.standard.")) return "standards.manage";
  return null;
}
