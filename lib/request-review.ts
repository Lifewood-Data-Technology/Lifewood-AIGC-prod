export type ReviewDecision = { status: "pending" | "confirmed" | "sales"; note: string };
type Row = Record<string, unknown>;
export const analysisListKeys = ["objectives", "audience", "platforms", "sourceMaterials", "brandRequirements", "prohibitedContent", "deadlineNotes", "uncertainties", "conflicts"];

export function analysisReviewToken(data: Row) {
  if (!Object.keys(data).length) return "";
  return String(data.resultVersion || JSON.stringify([data.summaryZh, data.summaryEn, data.uncertainties, data.conflicts]));
}

export function localizedAnalysisList(data: Row, key: string, locale: "zh" | "en") {
  const localized = data[`${key}${locale === "zh" ? "Zh" : "En"}`];
  const list = Array.isArray(localized) ? localized : data[key];
  return Array.isArray(list) ? list.map(String) : [];
}

export function reviewIssues(data: Row, locale: "zh" | "en") {
  return ["conflicts", "uncertainties"].flatMap(kind => {
    const base = Array.isArray(data[kind]) ? data[kind] as unknown[] : [];
    const localized = localizedAnalysisList(data, kind, locale);
    return base.map((value, index) => ({ id: `${kind}:${index}`, kind, text: localized[index] || String(value) }));
  });
}

export function intakeReviewBlockers(data: Row, decisions: Record<string, ReviewDecision>, token: string) {
  const issues = reviewIssues(data, "zh");
  const current = token === analysisReviewToken(data) ? decisions : {};
  return issues.filter(issue => issue.kind === "conflicts" ? current[issue.id]?.status !== "confirmed" || !String(current[issue.id]?.note || "").trim() : current[issue.id]?.status === "sales");
}
