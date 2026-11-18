import { PublicError } from "./security-controls";
import {validBusinessTitle} from "./business-title";
export type BusinessLocale = "zh" | "en";
export type BusinessNameKind = "project" | "video" | "request" | "client" | "client_legal" | "contact";
type Row = Record<string, unknown>;
const str = (value: unknown) => String(value ?? "");
export const hasChinese = (value: unknown) => /\p{Script=Han}/u.test(str(value));
export function nameFields(kind: string) {
  const field = kind === "request" ? "title" : kind === "contact" ? "contact_name" : kind === "client_legal" ? "legal_name" : "name";
  return { field, source: `source_${field}`, zh: `${field}_zh`, en: `${field}_en` };
}
export function originalBusinessName(row: Row, kind: string = "project") {
  const keys = nameFields(kind);
  return str(row[keys.source] || row[keys.field]);
}
export const languageLabels = [
  ["en-GB", "英语", "English"], ["en-US", "英语（美国）", "English (US)"], ["zh-CN", "中文", "Chinese"],
  ["ms-MY", "马来语", "Bahasa Melayu"], ["th-TH", "泰语", "Thai"],
  ["id-ID", "印度尼西亚语", "Indonesian"], ["vi-VN", "越南语", "Vietnamese"],
  ["ja-JP", "日语", "Japanese"], ["ko-KR", "韩语", "Korean"],
  ["yue-HK", "粤语", "Cantonese"], ["es-ES", "西班牙语", "Spanish"],
  ["pt-BR", "葡萄牙语", "Portuguese"], ["ar-SA", "阿拉伯语", "Arabic"],
  ["zh-TW", "繁体中文", "Chinese (Traditional)"], ["es-419", "西班牙语（拉丁美洲）", "Spanish (Latin America)"],
  ["fr-FR", "法语", "French"], ["de-DE", "德语", "German"], ["it-IT", "意大利语", "Italian"],
  ["ar", "阿拉伯语（未指定地区）", "Arabic (Unspecified region)"], ["hi-IN", "印地语", "Hindi"],
] as const;
export function languageLabel(code: unknown, fallback: unknown, locale: BusinessLocale) {
  const key = str(code).toLowerCase();
  const value = str(fallback).trim();
  const match = languageLabels.find(row => row[0].toLowerCase() === key || row.some(v => v.toLowerCase() === value.toLowerCase()));
  if (match) return match[locale === "zh" ? 1 : 2];
  if (key === "und") return locale === "zh" ? "待确认语言" : "Language needs review";
  return value || str(code);
}

// Detect the old word-replacement fallback only; never use it to generate a title.
const legacyWords: Array<[RegExp, string]> = [
  [/品牌故事/g,"Brand Story"],[/品牌/g,"Brand"],[/故事/g,"Story"],[/产品/g,"Product"],[/教育/g,"Education"],
  [/发布/g,"Launch"],[/宣传片/g,"Campaign Film"],[/招聘片/g,"Hiring Film"],[/短片/g,"Short Film"],
  [/预告片/g,"Trailer"],[/视频/g,"Video"],[/广告/g,"Campaign"],[/春节/g,"Lunar New Year"],
  [/斋月/g,"Ramadan"],[/夏季/g,"Summer"],[/汽车/g,"Automotive"],[/测试/g,"Test"],[/项目/g,"Project"],
];
export function isLegacyTitle(source: string, translation: string) {
  if (!/[\u3400-\u9fff]/.test(source)) return false;
  let old = source;
  for (const [pattern, replacement] of legacyWords) old = old.replace(pattern, ` ${replacement} `);
  old = old.replace(/\s+/g, " ").trim();
  return translation !== source && (translation === old || (/\p{Script=Han}/u.test(old) && /^Project [A-Za-z0-9_-]+$/.test(translation)));
}
export function nameNeedsTranslation(row: Row, kind: BusinessNameKind = "project") {
  const source = originalBusinessName(row, kind);
  if (!hasChinese(source)) return false;
  if (row.translation_status === "generated" || row.translation_status === "confirmed") return false;
  const en = str(row[nameFields(kind).en]).trim();
  return !en || hasChinese(en) || isLegacyTitle(source, en);
}
export function businessTitle(row: Row, locale: BusinessLocale, kind: BusinessNameKind = "project") {
  const source = originalBusinessName(row, kind);
  // Business names translate only Chinese -> English. Existing reverse caches
  // never replace an English original, and Chinese always shows the source.
  if (locale === "zh" || !hasChinese(source)) return source;
  const translated = str(row[nameFields(kind).en]);
  return translated && !hasChinese(translated) && (row.translation_status || !isLegacyTitle(source, translated)) ? translated : source;
}
export function applyNameTranslation(row: Row, kind: string, translations: Row[]) {
  const source = originalBusinessName(row, kind);
  const record = translations.find(t => t.entity_kind === kind && t.entity_id === row.id && t.source_name === source);
  if (!record || !["generated", "confirmed"].includes(str(record.status))) return row;
  const { zh: zhKey, en: enKey } = nameFields(kind);
  // A later manual edit always takes precedence over an older translation.
  if (str(row[zhKey]) !== str(record.base_zh) || str(row[enKey]) !== str(record.base_en)) return row;
  return { ...row, [zhKey]: record.name_zh, [enKey]: record.name_en, translation_status: record.status };
}

const eventNames: Record<string, [string, string]> = {
  "business.delete-customer": ["客户移入回收站", "Customer moved to recycle bin"],
  "business.delete-request": ["待受理项目移入回收站", "Pending project moved to recycle bin"],
  "business.restore-customer": ["客户已恢复", "Customer restored"],
  "business.restore-request": ["待受理项目已恢复", "Pending project restored"],
  project_request: ["项目需求", "Project brief"], assignment: ["任务分配", "Assignment"],
  materials: ["项目资料", "Project materials"], production: ["制作", "Production"], feedback: ["客户反馈", "Customer feedback"],
  status: ["状态更新", "Status update"], notification: ["通知", "Notification"], access: ["访问权限", "Access"],
  name: ["名称", "Name"], translation: ["译名", "Translation"], standards: ["素材标准", "Material standards"],
  submit: ["提交", "Submit"], review_submitted: ["质检已提交", "Review submitted"], render_submitted: ["成片已送审", "Render submitted"],
  accept: ["接受", "Accept"], rejected_login: ["登录被拒绝", "Login denied"], admin_released: ["管理员释放会话", "Session released by administrator"],
  handover: ["制作交接", "Handover"], review: ["质检", "Quality review"], delivery: ["交付", "Delivery"],
  customer_feedback: ["客户反馈", "Customer feedback"], customer_revision: ["客户修改", "Customer revision"],
  materials_required: ["补充资料", "Materials required"], system: ["系统通知", "System notification"],
  session: ["登录会话", "Session"], account: ["账号", "Account"], project: ["项目", "Project"],
  client: ["客户", "Customer"], file: ["文件", "File"], folder: ["文件夹", "Folder"],
  quality: ["质检", "Quality review"], asset: ["素材", "Asset"], language: ["语言任务", "Language task"],
  checkpoint: ["检查点", "Checkpoint"], request: ["项目需求", "Project brief"],
  "production.progress_saved": ["制作进度已保存", "Production progress saved"],
  signed_in: ["登录成功", "Signed in"], signed_out: ["主动退出", "Signed out"],
  created: ["已创建", "Created"], updated: ["已更新", "Updated"], deleted: ["已删除", "Deleted"],
  restored: ["已恢复", "Restored"], enabled: ["已启用", "Enabled"], disabled: ["已停用", "Disabled"],
  delivered: ["已交付", "Delivered"], approved: ["已通过", "Approved"], rejected: ["已驳回", "Rejected"],
  submitted: ["已提交", "Submitted"], confirmed: ["已确认", "Confirmed"], accepted: ["已接手", "Accepted"],
  paused: ["已暂停", "Paused"], resumed: ["已恢复", "Resumed"], terminated: ["已终止", "Terminated"],
  archived: ["已归档", "Archived"], unarchived: ["已取消归档", "Unarchived"],
  version_uploaded: ["新版本已上传", "Version uploaded"], uploaded: ["已上传", "Uploaded"],
  password_reset: ["密码已重置", "Password reset"], password_changed: ["密码已修改", "Password changed"],
  permissions_updated: ["权限已更新", "Permissions updated"], published: ["已发布", "Published"],
};
export function eventLabel(value: unknown, locale: BusinessLocale) {
  const key = str(value);
  const index = locale === "zh" ? 0 : 1;
  if (eventNames[key]) return eventNames[key][index];
  const parts = key.split(".");
  if (parts.every(part => eventNames[part])) return parts.map(part => eventNames[part][index]).join(" · ");
  return locale === "zh" ? "其他操作" : "Other event";
}

export function validateNamePair(source: string, value: unknown, allowTitleSymbols = false) {
  if (!hasChinese(source)) throw new PublicError("Only Chinese original names need translation.");
  if (!value || typeof value !== "object") throw new PublicError("Invalid translated name.");
  const data = value as Row;
  const zh = typeof data.zh === "string" ? data.zh.trim() : "";
  const en = typeof data.en === "string" ? data.en.trim() : "";
  if (allowTitleSymbols) { validBusinessTitle(String(data.zh ?? "")); validBusinessTitle(String(data.en ?? "")); }
  if (!zh || !en || [zh, en].some(v => v.length > 80 || (!allowTitleSymbols && /[\\/:*?"<>|\r\n]/.test(v))) ||
    /[\u3400-\u9fff]/.test(en) || !/[\u3400-\u9fff]/.test(zh))
    throw new PublicError("Invalid translated name.");
  // Original spelling/numbers remain authoritative in the source language.
  return { zh: source, en };
}

// Translate only the application's known default, not employees' free-text notes.
export function customerFeedbackSummary(row: Row, locale: BusinessLocale) {
  const summary = str(row.summary);
  if (row.decision === "confirmed" && (!summary.trim() || ["Customer confirmed the final.", "客户已确认成片。"].includes(summary.trim())))
    return locale === "zh" ? "客户已确认成片。" : "Customer confirmed the final.";
  return summary;
}
export function accountDisplayName(name: unknown, role: unknown, locale: "zh" | "en") {
  const original = String(name ?? "");
  return locale === "en" && role === "system" && original === "系统管理员" ? "System administrator" : original;
}
