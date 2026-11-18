type Row = Record<string, unknown>;
export function canOpenFileCentre(access: string) { return access === "project"; }

/** Presentation grouping only. Input records must already be authorized by the server. */
export function businessFileGroup(file: Row) {
  if (file.source === "request_document") return "docs";
  const code = String(file.folder_code || "");
  if (/^0[12](\.|$)/.test(code)) return "client";
  if (/^04(\.|$)/.test(code) || file.status === "quality_report") return "quality";
  return "finals";
}
