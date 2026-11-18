"use client";
import { DataListTable } from "./DataList";
import { browserRandomUUID } from "../lib/browser-crypto";
import { workspaceFetch as fetch } from "../lib/tab-session";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BackupCommand, BackupStatus } from "../lib/backup-contract";

const labels: Record<string, [string, string]> = {
  queued: ["等待执行", "Queued"], running: ["执行中", "Running"],
  completed: ["完成", "Completed"], failed: ["失败", "Failed"], interrupted: ["已中断，需检查", "Interrupted — check required"],
  locking: ["锁定源数据库，准备备份", "Locking source tables"],
  database: ["备份数据库", "Backing up database"], files: ["备份实际文件", "Backing up files"],
  verifying: ["校验备份文件", "Verifying backup files"], "checking-target": ["检查恢复目标", "Checking restore target"],
  "restoring-database": ["恢复数据库", "Restoring database"], "restoring-files": ["恢复并核对实际文件", "Restoring and checking files"],
  "awaiting-acceptance": ["恢复及数据校验完成，业务验收待完成", "Restored and data checked; functional acceptance pending"],
  backup: ["创建备份", "Create backup"], verify: ["校验备份", "Verify backup"], restore: ["恢复到验证环境", "Restore to verification environment"],
};
const errors: Record<string, [string, string]> = {
  BACKUP_NOT_CONFIGURED: ["尚未配置备份服务。", "Backup service is not configured."],
  BACKUP_SERVICE_UNAVAILABLE: ["连接未完成，请刷新记录确认任务状态，不要连续创建任务。", "Connection incomplete. Refresh the history to confirm the outcome before creating another job."],
  JOB_BUSY: ["已有任务在执行，请等待完成。", "Another job is running."],
  TARGET_NOT_EMPTY: ["目标已有数据，已停止恢复。请由技术人员准备新的空验证环境。", "Target is not empty. Prepare a fresh verification environment."],
  TARGET_NOT_ISOLATED: ["源与目标未正确隔离，已禁止恢复。", "Source and target are not isolated."],
  RESTORE_NOT_CONFIGURED: ["尚未配置独立恢复目标。", "An isolated restore target is not configured."],
  SOURCE_CHANGED: ["备份期间文件发生变化。此次备份不可用于恢复，请停写后重新创建。", "Files changed during backup. Pause all writers and create a new backup."],
  SOURCE_UPLOADS_PENDING: ["仍有未完成的上传，请先处理完再备份。", "There are pending uploads."],
  UNSUPPORTED_SCHEMA: ["数据库包含当前适配器不支持的结构，请技术人员检查，未标记备份成功。", "Unsupported database structures. A technician must review them."],
  UNSUPPORTED_BUCKET_VERSIONING: ["存储桶启用了原生版本历史，需使用支持全版本的适配器；当前未执行不完整备份。", "Native bucket version history needs a full-version adapter. No partial backup is marked complete."],
  CHECKSUM_MISMATCH: ["备份或恢复内容校验不一致，已停止。", "Backup or restored content does not match."],
  DATABASE_MISMATCH: ["恢复后的数据库核对不通过，不能用于业务。", "The restored database did not pass verification."],
  MYSQL_TOOL_FAILED: ["数据库备份工具执行失败，请检查服务端配置和权限。", "Database client failed. Check server configuration and permissions."],
  SOURCE_REFERENCE_MISSING: ["数据库引用的文件不在存储桶中，备份未通过。请先补齐或核对缺失文件。", "A database file reference is missing from the bucket. Review missing files first."],
  SOURCE_SCOPE_MISMATCH: ["数据库引用了其他存储位置，当前配置无法完整覆盖，请技术人员核对。", "Database references extend beyond the configured bucket. Review backup scope."],
  BACKUP_OPERATION_FAILED: ["操作失败，请技术人员检查。失败的备份不能恢复；失败的恢复目标不可投入使用。", "Operation failed. Do not use an incomplete backup or restore target."],
};

export default function BackupPanel({ locale }: { locale: "zh" | "en" }) {
  const zh = locale === "zh";
  const t = (key: string) => labels[key]?.[zh ? 0 : 1] ?? key;
  const errorText = (key: string) => errors[key]?.[zh ? 0 : 1] ?? errors.BACKUP_OPERATION_FAILED[zh ? 0 : 1];
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [choice, setChoice] = useState<{ operation: BackupCommand["operation"]; backupId?: string } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [page, setPage] = useState(0);
  const active = useRef(true);
  const submitting = useRef(false);
  const pending = useRef<BackupCommand | null>(null);
  const [retry, setRetry] = useState<BackupCommand | null>(null);
  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/backups", { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      const data = await response.json() as BackupStatus & { error?: string };
      if (!response.ok || !Array.isArray(data.jobs)) throw new Error(data.error ?? "BACKUP_SERVICE_UNAVAILABLE");
      if (active.current) {
        setStatus(data);
        if (pending.current && data.jobs.some(job => job.id === pending.current?.requestId)) {
          pending.current = null;
          setRetry(null); setChoice(null); setConfirmed(false); setConfirmation("");
        }
        setError(pending.current ? "BACKUP_SERVICE_UNAVAILABLE" : "");
      }
    } catch { if (active.current) setError("BACKUP_SERVICE_UNAVAILABLE"); }
    finally { if (active.current) setLoading(false); }
  }, []);
  useEffect(() => {
    active.current = true;
    void Promise.resolve().then(refresh);
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 8000);
    return () => { active.current = false; clearInterval(timer); };
  }, [refresh]);
  const busy = sending || !!status?.jobs.some(job => ["queued", "running"].includes(job.state));
  const select = (operation: BackupCommand["operation"], backupId?: string) => {
    setChoice({ operation, ...(backupId ? { backupId } : {}) });
    setConfirmed(false); setConfirmation("");
  };
  const submit = async () => {
    if (!choice || submitting.current) return;
    submitting.current = true;
    const command = pending.current ?? {
      ...choice, requestId: browserRandomUUID(), confirmation,
      writesPaused: choice.operation === "backup" && confirmed,
      targetIsolated: choice.operation === "restore" && confirmed,
    };
    pending.current = command;
    setRetry(command);
    setSending(true); setError("");
    try {
      const response = await fetch("/api/backups", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command), signal: AbortSignal.timeout(15_000) });
      const data = await response.json() as { error?: string };
      if (!response.ok) {
        if ([400, 401, 403, 409].includes(response.status)) { pending.current = null; setRetry(null); }
        throw new Error(data.error ?? "BACKUP_SERVICE_UNAVAILABLE");
      }
      pending.current = null; setRetry(null);
      if (active.current) { setChoice(null); await refresh(); }
    } catch (cause) { if (active.current) setError(cause instanceof Error && errors[cause.message] ? cause.message : "BACKUP_SERVICE_UNAVAILABLE"); }
    finally { submitting.current = false; if (active.current) setSending(false); }
  };
  const jobs = status?.jobs ?? [];
  return <section className="backup-panel" aria-labelledby="backup-title">
    <header><div><h2 id="backup-title">{zh ? "备份与恢复验证" : "Backup and restore verification"}</h2></div>
      <button className="secondary-button" type="button" disabled={sending} onClick={() => { setLoading(true); void refresh(); }}>{zh ? "刷新记录" : "Refresh"}</button></header>
    {error && <p role="alert" className="backup-notice">{errorText(error)}</p>}
    {!status ? <p role="status">{loading ? (zh ? "正在读取备份配置…" : "Loading backup configuration…") : (zh ? "无法读取状态，请刷新重试。" : "Unable to read status. Refresh to retry.")}</p> : <>
      <div className="backup-summary">
        <div><span>{zh ? "服务连接" : "Service"}</span><strong>{status.configured ? (zh ? "已连接 MySQL / Wasabi 备份服务" : "MySQL / Wasabi service connected") : (zh ? "未配置" : "Not configured")}</strong></div>
        <div><span>{zh ? "备份来源" : "Backup source"}</span><strong>{status.sourceLabel || (zh ? "尚未接入外部数据库和存储" : "External storage not connected")}</strong></div>
        <div><span>{zh ? "恢复目标" : "Restore target"}</span><strong>{status.targetLabel || (zh ? "未配置独立验证环境" : "No isolated verification target")}</strong></div>
      </div>
      {!status.configured && <p className="backup-notice">{zh ? "备份服务未配置，暂不能创建备份。" : "Backup service is not configured. Creating a backup is unavailable."}</p>}
      <div className="backup-actions"><button type="button" className="primary-button" disabled={!status.configured || busy || !!retry} onClick={() => select("backup")}>{zh ? "创建完整备份" : "Create full backup"}</button>
        </div>
      {choice && <div className="backup-confirm">
        <h3>{t(choice.operation)}</h3>
        <p>{choice.operation === "backup" ? (zh ? "包含配置数据库的所有表和存储桶内的实际文件，账号密码验证信息也会加密备份。请先停止所有写入和上传，并确认备份目录与业务存储独立。" : "Includes all tables and bucket objects, including encrypted credential records. Stop all writes and uploads; use an independent backup location.") :
          choice.operation === "restore" ? (zh ? "只恢复到预先配置的空验证环境，不覆盖原系统。恢复成功后仍需人工测试登录、权限、文件链接和业务流程。失败时目标可能有部分数据，不会自动删除，请技术人员检查。" : "Restores only to the configured empty verification target. Login, permissions, file links and workflows still require acceptance testing. A failed restore can leave partial data; no automatic cleanup occurs.") :
            (zh ? "检查备份文件是否完整、可解密。此操作不写入数据库，也不代表恢复演练已通过。" : "Checks archive integrity and decryption without writing a database. This is not a restore drill.")}</p>
        {choice.operation !== "verify" && <label className="backup-check"><input type="checkbox" checked={confirmed} disabled={sending || !!retry} onChange={event => setConfirmed(event.target.checked)} /><span>{choice.operation === "backup" ? (zh ? "已停止源系统写入和上传，并安排好维护时间" : "All source writers/uploads are stopped and maintenance is arranged") : (zh ? "验证环境与线上隔离，目标为空，自动通知和外部调用已停用" : "The target is isolated and empty; notifications and external calls are disabled")}</span></label>}
        <label className="backup-phrase"><span>{zh ? "输入确认词：" : "Type confirmation: "}{choice.operation.toUpperCase()}</span><input autoComplete="off" value={confirmation} disabled={sending || !!retry} onChange={event => setConfirmation(event.target.value)} /></label>
        <div className="backup-actions"><button className="primary-button" type="button" disabled={busy || confirmation !== choice.operation.toUpperCase() || (choice.operation !== "verify" && !confirmed)} onClick={() => void submit()}>{retry ? (zh ? "重试同一请求" : "Retry same request") : (zh ? "确认执行" : "Confirm")}</button>
          <button className="secondary-button" type="button" disabled={sending || !!retry} onClick={() => setChoice(null)}>{zh ? "取消" : "Cancel"}</button></div>
      </div>}
      <div className="backup-history"><h3>{zh ? "任务记录" : "Job history"}</h3>
        {!jobs.length ? <p>{zh ? "暂无备份任务。" : "No backup jobs."}</p> :
          <><DataListTable className="backup-table-scroll" ariaLabel={zh ? "备份任务记录" : "Backup job history"}><table><thead><tr><th>{zh ? "时间 / 操作" : "Time / action"}</th><th>{zh ? "状态 / 进度" : "Status / progress"}</th><th>{zh ? "操作人" : "Actor"}</th><th>{zh ? "后续操作" : "Actions"}</th></tr></thead><tbody>
            {jobs.slice(page * 10, page * 10 + 10).map(job => <tr key={job.id}><td><strong>{t(job.operation)}</strong><small>{new Date(job.createdAt).toLocaleString(zh ? "zh-CN" : "en-GB")}</small><small>{job.id.slice(0, 8)}{job.backupId ? " ← " + job.backupId.slice(0, 8) : ""}</small></td>
              <td><strong>{t(job.stage)}</strong><small>{job.tables} {zh ? "张表" : "tables"} · {job.objects} {zh ? "个文件" : "files"} · {(job.bytes / 1024 / 1024).toFixed(1)} MB</small>{job.error && <small className="backup-error">{errorText(job.error)}</small>}</td>
              <td>{job.actor}</td><td>{job.operation === "backup" && job.state === "completed" && <div className="backup-row-actions"><button type="button" className="secondary-button" disabled={busy || !!retry} onClick={() => select("verify", job.id)}>{zh ? "校验" : "Verify"}</button><button type="button" className="secondary-button" disabled={busy || !status.restoreConfigured || !!retry} onClick={() => select("restore", job.id)}>{zh ? "恢复验证" : "Restore drill"}</button></div>}</td></tr>)}
          </tbody></table></DataListTable><nav className="backup-actions" aria-label={zh ? "备份记录分页" : "Backup history pages"}><button type="button" className="secondary-button" disabled={page === 0} onClick={() => setPage(page - 1)}>{zh ? "上一页" : "Previous"}</button><span>{page + 1} / {Math.max(1, Math.ceil(jobs.length / 10))}</span><button type="button" className="secondary-button" disabled={(page + 1) * 10 >= jobs.length} onClick={() => setPage(page + 1)}>{zh ? "下一页" : "Next"}</button></nav></>}
      </div>
    </>}
  </section>;
}
