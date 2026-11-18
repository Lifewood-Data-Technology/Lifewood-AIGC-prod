"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import DialogSections from "./DialogSections";
import SelectControl from "./SelectControl";
import DataList from "./DataList";
import { DraftNotice, mayLeaveDrafts, useDraftOwner, useDraftRisk, useLocalDraft } from "./useLocalDraft";
import { downloadCustomerSheet, parseCustomerSpreadsheet, type CustomerImportRow } from "../lib/customer-spreadsheet";
import { requestWorkflow } from "../lib/workflow-client";
import { isConfirmedCustomerImport } from "../lib/customer-import-result";

type Row = Record<string, unknown>;
type ImportResult = { ok?: boolean; created?: number; skipped?: number; failed?: number; error?: string; code?: string; outcome?: string; results?: { row: number; status: string; message?: string; code?: string }[] };
type Draft = { rows: CustomerImportRow[]; fileName: string; salesEmail: string; pending: boolean; pendingPayload: Record<string, string> | null };
const empty: Draft = { rows: [], fileName: "", salesEmail: "", pending: false, pendingPayload: null };
function confirmedResult(body: ImportResult, payload: Record<string, string>) {
  const sent = JSON.parse(payload.rows) as CustomerImportRow[];
  return isConfirmedCustomerImport(body, sent.map(row => Number(row.sourceRow)));
}
const messages: Record<string, [string, string]> = {
  WORKBOOK_UNSUPPORTED: ["仅支持普通 .xlsx 或 CSV，不支持宏、嵌入对象或其他文件。", "Use a standard .xlsx or CSV without macros or embedded objects."],
  WORKBOOK_DAMAGED: ["文件已损坏或结构无效，请重新保存后导入。", "The file is damaged or invalid. Save it again before importing."],
  WORKBOOK_TOO_LARGE: ["文件超过 5 MB 或解压后的内容过大。", "The file exceeds 5 MB or its expanded content is too large."],
  WORKBOOK_FORMULA: ["工作簿包含公式，请粘贴为值后导入。", "This workbook contains formulas. Paste them as values first."],
  WORKBOOK_EXTERNAL_LINK: ["工作簿包含外部链接，请移除外部链接后导入。", "Remove external workbook links before importing."],
  TOO_MANY_ROWS: ["一次最多导入 500 行客户。", "Import up to 500 customer rows at a time."],
  NO_CUSTOMER_ROWS: ["文件中没有客户数据。", "No customer rows were found."],
  MISSING_HEADERS: ["缺少客户名称、公司全称、区域或行业表头，请使用模板。", "Name, legal name, region or industry headers are missing. Use the template."],
  DUPLICATE_HEADERS: ["存在重复表头，请使用模板。", "Duplicate headers were found. Use the template."],
};
export default function CustomerImportDialog({ locale, clients, salesOwners, validate, close, refresh, canImport = true }: {
  locale: "zh" | "en"; clients: Row[]; salesOwners?: Row[]; validate: (row: Record<string, string>) => Record<string, string>;
  close: () => void; refresh: () => void; canImport?: boolean;
}) {
  const zh = locale === "zh", owner = useDraftOwner();
  const draft = useLocalDraft<Draft>(owner ? `lifewood-form-draft:${owner}:customer-import` : "", empty, value => {
    const item = value as Draft;
    if (!item || !Array.isArray(item.rows) || item.rows.length > 500 || !item.rows.every(row => row && typeof row.sourceRow === "string" && Number.isSafeInteger(Number(row.sourceRow)) && Number(row.sourceRow) > 0 && Number(row.sourceRow) <= 1_000_000 && Object.values(row).every(cell => typeof cell === "string")) || new Set(item.rows.map(row => Number(row.sourceRow))).size !== item.rows.length || typeof item.fileName !== "string" || typeof item.salesEmail !== "string" || typeof item.pending !== "boolean") return null;
    if (item.pendingPayload && (typeof item.pendingPayload.rows !== "string" || !Object.values(item.pendingPayload).every(cell => typeof cell === "string"))) return null;
    return { ...item, pendingPayload: item.pendingPayload || null };
  });
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const latch = useRef(false), loading = useRef(false), mounted = useRef(true), authority = useRef({ owner, canImport });
  useLayoutEffect(() => { authority.current = { owner, canImport }; }, [owner, canImport]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const frozen = !canImport || busy || draft.value.pending || Boolean(draft.pending);
  useDraftRisk(busy || draft.value.pending || (draft.value.rows.length > 0 && draft.failed));
  const attemptClose = () => { if (mayLeaveDrafts(locale)) close(); };
  const load = async (file?: File) => {
    if (!file || frozen || loading.current) return;
    loading.current = true;
    const startedOwner = owner;
    setError(""); setResult(null); setBusy(true);
    try {
      const rows = await parseCustomerSpreadsheet(file);
      if (mounted.current && authority.current.owner === startedOwner && authority.current.canImport)
        draft.setValue({ rows, fileName: file.name, salesEmail: draft.value.salesEmail, pending: false, pendingPayload: null });
    } catch (reason) {
      if (mounted.current && authority.current.owner === startedOwner) { const key = reason instanceof Error ? reason.message : "WORKBOOK_DAMAGED"; setError((messages[key] || messages.WORKBOOK_DAMAGED)[zh ? 0 : 1]); }
    } finally { loading.current = false; if (mounted.current) setBusy(false); }
  };
  const seenNames = new Set<string>(), seenEmails = new Set<string>();
  const preview = draft.value.rows.map(values => {
    const errors = Object.values(validate(values));
    if (Object.values(values).some(value => value.length > 4000 || value.trimStart().startsWith("="))) errors.push(zh ? "单元格最多 4000 字符，且不支持公式。" : "Cells allow up to 4000 characters; formulas are not supported.");
    const name = values.name?.trim().toLowerCase(), email = values.contactEmail?.trim().toLowerCase();
    const duplicate = Boolean(name && seenNames.has(name) || email && seenEmails.has(email) || clients.some(client => String(client.name || "").trim().toLowerCase() === name || Boolean(email) && String(client.contact_email || "").trim().toLowerCase() === email));
    if (!errors.length) { if (name) seenNames.add(name); if (email) seenEmails.add(email); }
    return { values, errors, duplicate };
  });
  // Submit all structurally valid rows, including duplicate candidates; the server reports actual skips.
  const valid = preview.filter(item => !item.errors.length).map(item => item.values);
  const pendingPayload = draft.value.pending ? draft.value.pendingPayload : null;
  const canSubmit = canImport && !busy && !draft.pending && (draft.value.pending ? Boolean(pendingPayload) : valid.length > 0 && (!salesOwners || salesOwners.some(item => item.email === draft.value.salesEmail)));
  const unconfirmedText = zh ? "提交结果待核对。请保留此窗口，点击“核对导入结果”使用同一次提交核对，避免重复导入。" : "The result is unconfirmed. Keep this window and check the same submission before importing again.";
  const confirm = async () => {
    if (latch.current || !canSubmit) return;
    latch.current = true; setBusy(true); setError("");
    const startedOwner = owner;
    const payload = pendingPayload || { rows: JSON.stringify(valid), ...(salesOwners ? { salesEmail: draft.value.salesEmail } : {}) };
    draft.setValue({ ...draft.value, pending: true, pendingPayload: payload });
    try {
      const { response, body } = await requestWorkflow<ImportResult>("client.import", payload);
      if (!mounted.current || authority.current.owner !== startedOwner || !authority.current.canImport) return;
      if (response.status === 202 || response.status >= 500 || body.code === "SUBMISSION_UNCONFIRMED" || body.outcome === "unconfirmed") throw Error("UNCONFIRMED");
      if (!response.ok) { draft.setValue({ ...draft.value, pending: false, pendingPayload: null }); setError(body.error || (zh ? "导入被拒绝，请检查权限或数据后重试。" : "Import rejected. Check your access and data.")); return; }
      if (!confirmedResult(body, payload)) throw Error("UNCONFIRMED");
      setResult(body); draft.clear();
      try { refresh(); } catch { setError(zh ? "导入已完成，但刷新列表失败，请重新刷新。" : "Import completed, but the list could not refresh. Refresh it again."); }
    } catch { if (mounted.current && authority.current.owner === startedOwner && authority.current.canImport) setError(unconfirmedText); }
    finally { latch.current = false; if (mounted.current) setBusy(false); }
  };
  if (!canImport) return <div className="modal-backdrop"><section className="modal-card customer-import-dialog" role="dialog" aria-modal="true" aria-labelledby="customer-import-title"><DialogSections>
    <header><h2 id="customer-import-title">{zh ? "导入客户" : "Import customers"}</h2></header>
    <p role="alert">{zh ? "当前账号暂无客户导入权限。" : "Customer import is not available for this account."}</p>
    <footer><button type="button" className="secondary-button" onClick={attemptClose}>{zh ? "关闭" : "Close"}</button></footer>
  </DialogSections></section></div>;
  return <div className="modal-backdrop"><section className="modal-card customer-import-dialog" role="dialog" aria-modal="true" aria-labelledby="customer-import-title"><DialogSections>
    <header><div><h2 id="customer-import-title">{zh ? "导入客户" : "Import customers"}</h2><p>{zh ? ".xlsx / CSV · 最多 500 行 · 仅新增" : ".xlsx / CSV · Up to 500 rows · Add only"}</p></div><button type="button" className="close-button" onClick={attemptClose} aria-label={zh ? "关闭" : "Close"}>×</button></header>
    <DraftNotice draft={{ ...draft, clear: () => {
      if (draft.value.pending || draft.pending?.value.pending) { setError(unconfirmedText); return; }
      draft.clear();
    } }} locale={locale} hasFileUploads={false}/>
    <div className="customer-import-controls">
      <label className={`secondary-button${frozen ? " is-disabled" : ""}`}>{zh ? "选择文件" : "Choose file"}<input type="file" accept=".xlsx,.csv" disabled={frozen} onChange={event => { void load(event.target.files?.[0]); event.target.value = ""; }}/></label>
      <button type="button" className="secondary-button" onClick={() => downloadCustomerSheet([{ name: zh ? "示例客户（导入前删除）" : "Example (remove before import)", legalName: "Example Ltd", region: "Singapore", industry: "Technology", status: "Active" }], "xlsx", true)}>{zh ? "下载模板" : "Download template"}</button>
      {salesOwners && <label>{zh ? "负责销售" : "Sales owner"}<SelectControl locale={locale} value={draft.value.salesEmail} disabled={frozen} onChange={event => draft.setValue({ ...draft.value, salesEmail: event.target.value })}><option value="">{zh ? "请选择" : "Select"}</option>{salesOwners.map(item => <option key={String(item.email)} value={String(item.email)}>{String(item.name || item.email)}</option>)}</SelectControl></label>}
      <span>{draft.value.fileName}</span>
    </div>
    {error && <p role="alert" className="field-error">{error}</p>}
    {result ? <DataList summary={<span role="status">{zh ? `已创建 ${result.created || 0} · 已跳过 ${result.skipped || 0} · 失败 ${result.failed || 0}` : `Created ${result.created || 0} · Skipped ${result.skipped || 0} · Failed ${result.failed || 0}`}</span>}><div className="work-table-wrap"><table className="work-table"><thead><tr><th>{zh ? "行" : "Row"}</th><th>{zh ? "结果" : "Result"}</th><th>{zh ? "明细" : "Details"}</th></tr></thead><tbody>{result.results?.map(item => <tr key={item.row}><td>{item.row}</td><td>{zh ? ({ created: "已创建", skipped: "已跳过", error: "失败" }[item.status] || item.status) : item.status}</td><td>{item.message || "—"}</td></tr>)}</tbody></table></div></DataList> : preview.length > 0 ? <DataList summary={<span>{zh ? `${preview.length} 行 · ${valid.length} 行可提交 · ${preview.length - valid.length} 行需修正` : `${preview.length} rows · ${valid.length} ready · ${preview.length - valid.length} invalid`}</span>}><div className="work-table-wrap"><table className="work-table"><thead><tr>{(zh ? ["行", "客户", "公司", "联系人", "邮箱", "校验"] : ["Row", "Customer", "Company", "Contact", "Email", "Validation"]).map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{preview.map(({ values, errors, duplicate }) => <tr key={values.sourceRow}><td>{values.sourceRow}</td><td>{values.name || "—"}</td><td>{values.legalName || "—"}</td><td>{values.contactName || "—"}</td><td>{values.contactEmail || "—"}</td><td className={errors.length ? "danger-text" : ""}>{errors.join(" ") || (duplicate ? (zh ? "疑似重复，提交时核对并跳过" : "Possible duplicate; checked on submit") : (zh ? "可导入" : "Ready"))}</td></tr>)}</tbody></table></div></DataList> : <p>{zh ? "选择文件后预览校验结果。联系人、电话和邮箱可留空。" : "Choose a file to review its rows. Contact, phone and email may be blank."}</p>}
    <footer><button type="button" className="secondary-button" onClick={attemptClose}>{zh ? "关闭" : "Close"}</button>{!result && <button type="button" className="primary-button" disabled={!canSubmit} onClick={() => void confirm()}>{busy ? (zh ? "处理中…" : "Processing…") : draft.value.pending ? (zh ? "核对导入结果" : "Check import result") : (zh ? `确认导入 ${valid.length} 行` : `Import ${valid.length} rows`)}</button>}</footer>
  </DialogSections></section></div>;
}
