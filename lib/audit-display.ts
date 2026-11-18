import { accountPermissionLabels, accountRoles, type AccountPermissionKey } from "./account-management";
import { eventLabel, accountDisplayName } from "./business-locale";
import { logCsv } from './log-query-controls';
import { safeIp } from './account-access';
/** Network scope only; private addresses do not identify a geographic place. */
export function auditLocationLabel(ip: string | null, locale: 'zh' | 'en') {
  const value=safeIp(ip);
  if(!value)return locale==='zh'?'未记录':'Not recorded';
  if(value==='::1'||value.startsWith('127.'))return locale==='zh'?'本机':'Local host';
  const parts=value.split('.').map(Number);
  if(parts.length===4&&(parts[0]===10||parts[0]===192&&parts[1]===168||parts[0]===172&&parts[1]>=16&&parts[1]<=31)||/^(?:fc|fd|fe[89ab])/i.test(value))return locale==='zh'?'内网地址':'Private network';
  return locale==='zh'?'未解析地理位置':'Location not resolved';
}
export type AuditStatus = 'success' | 'failure' | 'unconfirmed';
export type AuditRecord = { id: number; action: string; operation: string; actor_email: string; actor_name: string | null; actor_role: string | null; subject: string; subject_name: string | null; subject_role: string | null; details: string; created_at: string; module: string; ip_address: string | null; status: AuditStatus | null; duration_ms: number | null; request_id: string | null; error_code: string | null };
export type AuditPageData = { rows: AuditRecord[]; total: number; page: number; pageSize: number; actions: string[]; modules: string[] };
type Locale = "zh" | "en";
export const auditModuleLabels: Record<string, [string, string]> = {
  system: ['系统管理', 'System management'], customers: ['客户管理', 'Customers'], projects: ['项目管理', 'Projects'],
  production: ['制作任务', 'Production'], quality: ['质检管理', 'Quality review'], files: ['文件管理', 'Files'],
  delivery: ['交付管理', 'Delivery'], other: ['其他', 'Other'],
};
/** Explicit families prevent arbitrary historic action codes becoming menu labels. */
export const auditModulePrefixes: Record<string, readonly string[]> = {
  system: ['account.', 'session.', 'settings.', 'admin.', 'logs.', 'audit.', 'name.', 'request.accounts.', 'request.directory.', 'request.settings.', 'request.mfa.', 'request.backups.', 'request.name-translations.', 'request.content-translations.', 'request.audit.', 'request.login-log.', 'request.logs.'],
  customers: ['client.', 'clients.', 'business.delete-customer', 'business.restore-customer'],
  delivery: ['customer.', 'project.delivered'],
  production: ['production.', 'version.', 'request.production.'], quality: ['quality.'],
  files: ['file.', 'library_asset.', 'asset_collection.', 'material_standard.', 'share.', 'request.files.', 'request.folders.', 'request.documents.', 'request.shares.'],
  projects: ['project.', 'project_request.', 'request.', 'business.'],
};
export function auditModule(action: string): string {
  return Object.entries(auditModulePrefixes).find(([, prefixes]) => prefixes.some(prefix => action.startsWith(prefix)))?.[0] || 'other';
}
export function auditModuleLabel(module: string, locale: Locale): string { return auditModuleLabels[module]?.[locale === 'zh' ? 0 : 1] || auditModuleLabels.other[locale === 'zh' ? 0 : 1]; }
export function auditStatusLabel(status: AuditStatus | null | undefined, locale: Locale): string {
  const labels: Record<string, [string, string]> = { success: ['成功', 'Success'], failure: ['失败', 'Failed'], unconfirmed: ['待核对', 'Unconfirmed'] };
  return (labels[status || ''] || ['未记录', 'Not recorded'])[locale === 'zh' ? 0 : 1];
}
export function auditLogCsv(rows: AuditRecord[]): string {
  return logCsv(['id', 'module', 'operation', 'actor_email', 'actor_name', 'subject', 'subject_name', 'ip_address', 'status', 'created_at', 'duration_ms', 'request_id', 'error_code', 'details'], rows.map(row => [row.id, row.module, row.operation, row.actor_email, row.actor_name, row.subject, row.subject_name, row.ip_address, row.status, row.created_at, row.duration_ms, row.request_id, row.error_code, row.details]));
}
export const auditActionNames: Record<string, [string, string]> = {
  "integration.deseret_received": ["接收 Deseret 集成事件", "Receive Deseret integration event"],
  "project.deseret_action": ["处理 Deseret 项目", "Update Deseret project"],
  "admin.directory.save": ["保存管理配置", "Save management configuration"],
  "admin.directory.organization": ["修改组织归属", "Change organization assignment"],
  "logs.deleted": ["永久清理日志", "Permanently delete logs"],
  "audit.request_failed": ["操作请求失败", "Operation request failed"],
  "audit.request_unconfirmed": ["操作结果待核对", "Operation result unconfirmed"],
  "session.signed_in": ["登录账号", "Sign in"],
  "account.created": ["创建账号", "Create account"], "account.updated": ["编辑账号", "Edit account"],
  "account.permissions_updated": ["修改员工权限", "Change employee permissions"], "account.password_reset": ["重置密码", "Reset password"],
  "account.disabled": ["停用账号", "Disable account"], "account.enabled": ["启用账号", "Enable account"],
  "account.password_changed": ["修改密码", "Change password"], "session.admin_released": ["解除异常登录", "Release session"],
  "settings.updated": ["修改系统配置", "Change system settings"],
  "account.mfa.start": ["开始绑定双重验证", "Start MFA setup"],
  "account.mfa.confirm": ["确认启用双重验证", "Enable MFA"],
  "account.mfa.disable": ["关闭双重验证", "Disable MFA"],
  "name.translation.confirmed": ["确认名称翻译", "Confirm name translation"],
  "client.created": ["创建客户", "Create customer"],
  "client.updated": ["编辑客户", "Edit customer"],
  "client.disabled": ["停用客户", "Disable customer"],
  "clients.batch_updated": ["批量编辑客户", "Bulk edit customers"],
  "client.imported": ["导入客户", "Import customer"],
  "business.delete-customer": ["客户移入回收站", "Move customer to recycle bin"],
  "business.restore-customer": ["恢复客户", "Restore customer"],
  "business.delete-request": ["待受理项目移入回收站", "Move pending project to recycle bin"],
  "business.restore-request": ["恢复待受理项目", "Restore pending project"],
  "request.created": ["创建项目需求", "Create project brief"],
  "project_request.submitted": ["提交项目需求", "Submit project brief"],
  "project_request.resubmitted": ["重新提交项目需求", "Resubmit project brief"],
  "project_request.supplement_requested": ["要求补充项目需求", "Request additional brief information"],
  "project_request.plan_saved": ["保存项目受理计划", "Save project intake plan"],
  "project_request.linked_project_updated": ["更新关联项目", "Update linked project"],
  "project_request.accepted": ["受理项目需求", "Accept project brief"],
  "project_request.document_uploaded": ["上传需求文档", "Upload brief document"],
  "project_request.document_removed": ["移除需求文档", "Remove brief document"],
  "project_request.ai_analyzed": ["分析项目需求", "Analyze project brief"],
  "project_request.ai_confirmed": ["确认需求分析", "Confirm brief analysis"],
  "project.created": ["创建项目", "Create project"],
  "project.updated": ["编辑项目", "Edit project"],
  "project.video_added": ["新增视频任务", "Add video task"],
  "project.language_added": ["新增语言任务", "Add language task"],
  "project.video.update": ["编辑视频任务", "Edit video task"],
  "project.language.update": ["编辑语言任务", "Edit language task"],
  "project.archived": ["归档项目", "Archive project"],
  "project.unarchived": ["取消项目归档", "Unarchive project"],
  "project.pause": ["暂停语言任务", "Pause language task"],
  "project.resume": ["恢复语言任务", "Resume language task"],
  "project.terminate": ["终止语言任务", "Terminate language task"],
  "project.schedule": ["调整人员安排", "Change task assignment"],
  "project.handover_prepared": ["发起制作交接", "Prepare production handover"],
  "project.language_assigned": ["分配语言任务", "Assign language task"],
  "project.materials_requested": ["要求补充项目素材", "Request project materials"],
  "project.materials_confirmed": ["确认项目素材", "Confirm project materials"],
  "project.delivered": ["完成项目交付", "Deliver project"],
  "file.uploaded": ["上传文件", "Upload file"],
  "file.preview_generated": ["生成文件预览", "Generate file preview"],
  "file.soft_deleted": ["文件移入回收站", "Move file to recycle bin"],
  "library_asset.uploaded": ["上传素材库文件", "Upload library asset"],
  "asset_collection.updated": ["更新素材集合", "Update asset collection"],
  "asset_collection.created": ["创建素材集合", "Create asset collection"],
  "asset_collection.restored": ["恢复素材集合", "Restore asset collection"],
  "asset_collection.soft_deleted": ["素材集合移入回收站", "Move asset collection to recycle bin"],
  "material_standard.saved": ["保存客户素材标准", "Save material standard"],
  "material_standard.current_selected": ["选择当前素材标准", "Select current material standard"],
  "share.created": ["创建文件分享", "Create file share"],
  "share.revoked": ["撤销文件分享", "Revoke file share"],
  "version.created": ["创建成片版本", "Create final version"],
  "production.progress_saved": ["保存制作进度", "Save production progress"],
  "production.flow_reopened": ["重新打开制作阶段", "Reopen production stage"],
  "production.final_promoted": ["流程文件登记为成片", "Register workflow file as final"],
  "production.materials_saved": ["保存制作素材", "Save production materials"],
  "production.daily_report_saved": ["保存工作日报", "Save daily report"],
  "production.checkpoint_saved": ["保存每日检查点", "Save daily checkpoint"],
  "production.checkpoint_edited": ["编辑每日检查点", "Edit daily checkpoint"],
  "production.checkpoint_corrected": ["更正每日检查点", "Correct daily checkpoint"],
  "production.checkpoint_invalidated": ["作废每日检查点", "Invalidate daily checkpoint"],
  "production.handover_accepted": ["接受制作交接", "Accept production handover"],
  "production.final_replaced": ["替换待审成片", "Replace pending final"],
  "production.submitted_qc": ["提交成片质检", "Submit final for review"],
  "quality.reviewed": ["提交质检结果", "Submit quality review"],
  "customer.feedback_recorded": ["记录客户反馈", "Record customer feedback"],
  "customer.feedback_resolved": ["处理客户反馈", "Resolve customer feedback"],
};
const requestCategories: Record<string, [string, string]> = {
  accounts: ['账号', 'Account'], directory: ['组织与权限', 'Organization and permissions'], settings: ['设置', 'Settings'],
  mfa: ['双重验证', 'MFA'], backups: ['备份', 'Backup'], workflow: ['业务流程', 'Business workflow'], files: ['文件', 'File'],
  folders: ['文件夹', 'Folder'], production: ['制作', 'Production'], documents: ['文档', 'Document'], analysis: ['需求分析', 'Brief analysis'],
  'business-deletion': ['业务删除', 'Business deletion'], recycle: ['回收站', 'Recycle bin'], 'name-translations': ['名称翻译', 'Name translation'],
  'content-translations': ['内容翻译', 'Content translation'], shares: ['分享', 'Share'], audit: ['操作日志', 'Operation log'], 'login-log': ['登录日志', 'Login log'], logs: ['日志清理', 'Log cleanup'],
};
for (const [category, label] of Object.entries(requestCategories)) {
  auditActionNames[`request.${category}.failure`] = [`${label[0]}操作失败`, `${label[1]} operation failed`];
  auditActionNames[`request.${category}.unconfirmed`] = [`${label[0]}操作待核对`, `${label[1]} operation unconfirmed`];
}
// Keep known operations available even in a new Test database; preserve historical types.
export function auditActionOptions(recorded: string[]) { return [...new Set([...Object.keys(auditActionNames), ...recorded])]; }
export function auditActionLabel(action: string, locale: Locale) { return auditActionNames[action]?.[locale === "zh" ? 0 : 1] || (eventLabel(action, locale) === (locale === "zh" ? "其他操作" : "Other event") ? `${locale === "zh" ? "其他操作" : "Other event"}（${action}）` : eventLabel(action, locale)); }
const roleLabel = (role: string, locale: Locale) => accountRoles.find(item => item.key === role)?.name[locale === "zh" ? 0 : 1] || role;
export function auditActor(row: AuditRecord, locale: Locale) {
  return row.actor_name ? accountDisplayName(row.actor_name, row.actor_role || "", locale) : row.actor_email || (locale === "zh" ? "系统" : "System");
}
export function auditSubject(row: AuditRecord, locale: Locale) {
  if (row.subject_name) return accountDisplayName(row.subject_name, row.subject_role || "", locale);
  if (row.subject === "System settings") return locale === "zh" ? "系统配置" : "System settings";
  return row.subject || "—";
}
export function auditSummary(row: AuditRecord, locale: Locale): string {
  const zh = locale === "zh", details = row.details || "";
  if (row.action === "session.signed_in" && ["Password sign-in", "Original browser session recovered"].includes(details)) return details === "Password sign-in" ? zh ? "密码登录成功" : "Password sign-in succeeded" : zh ? "原浏览器恢复登录" : "Original browser session recovered";
  if (row.action === "account.created") { const role = details.split(" · ").at(-1) || ""; return `${zh ? "角色" : "Role"}：${roleLabel(role, locale)}`; }
  if (row.action === "account.disabled" || row.action === "account.enabled") return `${zh ? "账号状态" : "Account status"}：${row.action === "account.disabled" ? zh ? "停用" : "Disabled" : zh ? "启用" : "Active"}`;
  if (row.action === "account.password_changed") return zh ? "密码已修改；所有会话已退出" : "Password changed; all sessions revoked";
  if (row.action === "session.admin_released") return `${zh ? "解除原因" : "Release reason"}：${details}`;
  if (row.action === "settings.updated" && /^\d+ settings saved$/.test(details)) return zh ? `已保存 ${details.split(" ")[0]} 项配置` : details;
  if (row.action === "settings.updated") {
    try {
      const settings = JSON.parse(details);
      const labels: Record<string, [string, string]> = { requireStrongPasswords: ["强密码策略", "Strong passwords"], lockRepeatedFailures: ["连续失败锁定", "Lock repeated failures"], sessionDuration: ["会话时长", "Session duration"], securityAlerts: ["安全提醒", "Security alerts"], accountChanges: ["账号变更提醒", "Account change alerts"], weeklyReport: ["每周报告", "Weekly report"] };
      const entries = Object.entries(labels).filter(([key]) => typeof settings?.[key] === "string").map(([key, label]) => `${label[zh ? 0 : 1]}：${key === "sessionDuration" ? `${settings[key]} ${zh ? "小时" : "hours"}` : settings[key] === "true" ? zh ? "开启" : "On" : settings[key] === "false" ? zh ? "关闭" : "Off" : settings[key]}`);
      if (entries.length) return entries.join("；");
    } catch { /* Historical free-text settings records remain readable. */ }
  }
  if (row.action === "account.updated") {
    const changes: string[] = [];
    const role = / · role (\w+) → (\w+)/.exec(details);
    if (role && role[1] !== role[2]) changes.push(`${zh ? "角色" : "Role"}：${roleLabel(role[1], locale)} → ${roleLabel(role[2], locale)}`);
    if (details.includes(" · password reset")) changes.push(zh ? "密码已重置" : "Password reset");
    const permissions = details.split(" · permissions ")[1];
    if (permissions) {
      try {
        const parsed = JSON.parse(permissions);
        for (const key of Object.keys(accountPermissionLabels) as AccountPermissionKey[]) {
          const value = parsed?.[key];
          if (typeof value?.from === "boolean" && typeof value?.to === "boolean") changes.push(`${accountPermissionLabels[key][zh ? 0 : 1]}：${value.from ? zh ? "开启" : "On" : zh ? "关闭" : "Off"} → ${value.to ? zh ? "开启" : "On" : zh ? "关闭" : "Off"}`);
        }
      } catch { /* Preserve the recorded text when an old record cannot be parsed. */ }
    }
    if (changes.length) return changes.join("；");
    if (permissions) return details;
    if (role) return `${zh ? "姓名" : "Name"}：${details.split(" · role ")[0]}；${zh ? "角色" : "Role"}：${roleLabel(role[2], locale)}`;
  }
  return details || "—";
}
