"use client";
import type { LoginLogRow } from "../lib/admin-login-log";
import { loginLogStatus } from "../lib/admin-login-log";
import { loginEventLabels } from "../lib/account-access";
import { accessTime } from "./AccountAccessPanel";
import LogDetailDialog, { LogDetailFields } from "./LogDetailDialog";
import { logStatusLabel } from "./AdminLogControls";
export default function AdminLoginLogDetail({ row, locale, close, returnFocus }: { row: LoginLogRow; locale: "zh" | "en"; close: () => void; returnFocus?: HTMLElement | null }) {
  const zh = locale === "zh", missing = zh ? "未记录" : "Not recorded";
  const fields: [string, string | null][] = [[zh ? "访问编号" : "Access ID", row.id], [zh ? "用户名称" : "User name", row.account_name], [zh ? "用户邮箱" : "Account email", row.account_email], [zh ? "登录地址" : "IP address", row.ip_address], [zh ? "登录地点" : "Location", missing], [zh ? "浏览器" : "Browser", row.browser], [zh ? "操作系统" : "Operating system", row.os], [zh ? "登录状态" : "Status", logStatusLabel(row.status || loginLogStatus(row.event), locale)], [zh ? "操作信息" : "Event information", loginEventLabels[row.event]?.[zh ? 0 : 1] || row.event], [zh ? "登录日期（上海）" : "Login date (Shanghai)", accessTime(row.occurred_at, locale)]];
  return <LogDetailDialog locale={locale} title={zh ? "登录日志详情" : "Login log details"} close={close} returnFocus={returnFocus}><LogDetailFields fields={fields} missing={missing} /></LogDetailDialog>;
}
