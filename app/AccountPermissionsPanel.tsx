"use client";
import DataList, { DataListTable } from "./DataList";
import SelectControl from "./SelectControl";
import DialogSections from "./DialogSections";
import { useEffect, useRef, useState } from "react";
import { workspaceFetch } from "../lib/tab-session";
import { accountRoles, accountRoleCounts, accountPermissionLabels, accountPermissionGuidance, accountPermissionDisabledEffect, accountPermissionSummary, accountPermissionKeys, accountPermissionValues, isAdminPermission, permissionAllowedForRole, type AccountPermissionKey } from "../lib/account-management";
import { SearchIcon } from "./ControlIcons";
import { useDraftRisk } from "./useLocalDraft";

type Locale = "zh" | "en";
type Row = Record<string, unknown>;
const label = (value: unknown) => String(value ?? "");
const roleName = (group: unknown, locale: Locale) => accountRoles.find(role => role.key === group)?.name[locale === "zh" ? 0 : 1] || label(group);

export function PermissionDialog({ account, locale, close, saved }: { account: Row; locale: Locale; close: () => void; saved: () => void }) {
  const zh = locale === "zh";
  const [initial] = useState(() => ({ group: account.group, revision: account.revision, permissions: accountPermissionValues(account.permissions) }));
  const [values, setValues] = useState(initial.permissions);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const sending = useRef(false);
  const mounted = useRef(true);
  const dialog = useRef<HTMLDialogElement>(null);
  const current = accountPermissionValues(account.permissions);
  const stale = initial.revision !== account.revision || initial.group !== account.group || accountPermissionKeys.some(key => current?.[key] !== initial.permissions?.[key]);
  const administrator = account.group === "system";
  const defaults = accountPermissionValues(account.permissionDefaults);
  const role = accountRoles.find(item => item.key === account.group);
  const languageIndex = zh ? 0 : 1;
  const changes = values && initial.permissions ? accountPermissionKeys.filter(key => !isAdminPermission(key) && values[key] !== initial.permissions?.[key]) : [];
  useDraftRisk(changes.length > 0 || busy || uncertain);
  useEffect(() => {
    mounted.current = true;
    const node = dialog.current;
    node?.showModal();
    return () => { mounted.current = false; node?.close(); };
  }, []);
  const dismiss = () => {
    if (sending.current) return;
    if ((changes.length || uncertain) && !window.confirm(zh ? "修改尚未确认保存。关闭并放弃当前编辑吗？" : "Changes are not confirmed saved. Close and discard this edit?")) return;
    close();
  };
  const submit = async () => {
    if (sending.current || !confirming || !changes.length || !values || stale || administrator || uncertain || forbidden) return;
    sending.current = true; setBusy(true); setError("");
    try {
      const response = await workspaceFetch("/api/accounts", {
        method: "PATCH", headers: { "content-type": "application/json" }, credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ targetEmail: label(account.email), expectedRevision: account.revision, permissions: Object.fromEntries(changes.map(key => [key, values[key]])) }),
      });
      const result = await response.json().catch(() => null) as { ok?: boolean } | null;
      if (!mounted.current) return;
      if (response.ok && result?.ok === true) { saved(); return; }
      if (response.status === 401 || response.status === 403 || response.status === 409) {
        setForbidden(true);
        setError(zh ? "账号状态或权限已改变，请关闭窗口，刷新后重新核对。" : "The account or permissions changed. Close this window, refresh and review again.");
      } else if (response.status >= 500 || response.ok) {
        setUncertain(true);
        setError(zh ? "保存结果尚未确认。请关闭窗口，刷新账号权限后核对结果，不要重复提交。" : "The save result is unconfirmed. Close, refresh permissions and verify the result before submitting again.");
      } else setError(zh ? "权限未保存，请检查账号状态后重试。" : "Permissions were not saved. Check the account and try again.");
    } catch {
      if (mounted.current) { setUncertain(true); setError(zh ? "连接中断，保存结果尚未确认。请关闭窗口，刷新账号权限后核对结果。" : "Connection interrupted; the save result is unconfirmed. Close, refresh permissions and verify the result."); }
    } finally { sending.current = false; if (mounted.current) setBusy(false); }
  };
  const locked = busy || administrator || stale || uncertain || forbidden;
  return <dialog ref={dialog} className="account-access-dialog account-permission-dialog" aria-labelledby="account-permission-title" onCancel={event => { event.preventDefault(); dismiss(); }}><DialogSections>
    <header><div><h2 id="account-permission-title">{zh ? "员工权限" : "Employee permissions"} · {label(account.name)}</h2><p>{label(account.email)} · {roleName(account.group, locale)}</p></div><button className="secondary-button" disabled={busy} onClick={dismiss}>{zh ? "关闭" : "Close"}</button></header>
    <div className="account-access-dialog-body">
      <p hidden={!administrator}>{zh ? "管理员权限只读" : "Administrator permissions are read-only"}</p>

      {stale && <p role="alert">{zh ? "此账号的角色或权限已更新，请关闭后重新打开，核对最新权限。" : "This account's role or permissions changed. Close and reopen to review the latest values."}</p>}
      <section className="permission-role-context" aria-label={zh ? "角色职责与数据范围" : "Role and data scope"}>
        <h3>{zh ? "角色职责与数据范围" : "Role and data scope"}</h3>
        <p>{role?.description[languageIndex]}</p>
        <p>{zh ? "功能开关不会扩大该角色的项目或任务可见范围。" : "Function switches do not expand this role's project or task visibility."}</p>
      </section>
      {!values ? <p role="alert">{zh ? "权限信息不完整，暂不能编辑。请关闭并刷新后重试。" : "Permission information is incomplete. Close and refresh before editing."}</p> : confirming ? <section className="permission-confirmation" aria-label={zh ? "确认权限变更" : "Confirm permission changes"}>
        <h3>{zh ? `确认修改 ${label(account.name)} 的 ${changes.length} 项权限` : `Confirm ${changes.length} permission changes for ${label(account.name)}`}</h3>
        <ul>{changes.map(key => <li key={key}><div className="permission-change-title"><span>{accountPermissionLabels[key][languageIndex]}</span><strong>{values[key] ? zh ? "关闭 → 开启" : "Off → On" : zh ? "开启 → 关闭" : "On → Off"}</strong></div><p>{(values[key] ? accountPermissionGuidance[key].purpose : accountPermissionDisabledEffect(key, account.group))[languageIndex]}</p></li>)}</ul>
        <p>{zh ? "仅保存以上变更，其他权限保持当前设置。" : "Only these changes will be saved; other permissions keep their current settings."}</p>
      </section> : <section aria-label={zh ? "权限设置" : "Permission settings"}>
        <div className="permission-settings-heading"><h3>{zh ? "权限设置" : "Permission settings"}</h3><span role="status">{changes.length ? zh ? `${changes.length} 项未保存` : `${changes.length} unsaved` : zh ? "无待保存变更" : "No unsaved changes"}</span></div>
        {!defaults && <p className="permission-default-unavailable">{zh ? "默认信息暂不可用" : "Default information is unavailable"}</p>}
        <div className="account-permission-editor">
        {accountPermissionKeys.filter(key => permissionAllowedForRole(account.group, key)).map((key: AccountPermissionKey) => {
          const changed = changes.includes(key);
          return <div key={key} className={`permission-setting${changed ? " is-changed" : ""}${key === "assets.manage" ? " is-global" : ""}`}>
            <div className="permission-setting-copy">
              <span className="permission-setting-title"><strong>{accountPermissionLabels[key][languageIndex]}</strong>{key === "assets.manage" && <span className="permission-scope-badge">{zh ? "跨个人素材" : "Across owners"}</span>}{changed && <span className="permission-change-badge">{zh ? "未保存" : "Unsaved"}</span>}</span>
              {key === "assets.manage" && <span className="permission-setting-description" id={`permission-description-${key}`}>{accountPermissionGuidance[key].purpose[languageIndex]}</span>}
              <details className="permission-explanation"><summary>{zh ? "查看说明" : "View explanation"}</summary>
                {key !== "assets.manage" && <span className="permission-setting-description" id={`permission-description-${key}`}>{accountPermissionGuidance[key].purpose[languageIndex]}</span>}
                {!administrator && <span className="permission-setting-impact">{zh ? "关闭后：" : "When off: "}{accountPermissionDisabledEffect(key, account.group)[languageIndex]}</span>}
              </details>
              <span className="permission-setting-default">{defaults ? `${zh ? "角色默认：" : "Role default: "}${defaults[key] ? zh ? "开启" : "On" : zh ? "关闭" : "Off"}` : zh ? "默认信息暂不可用" : "Default information is unavailable"}{defaults && values[key] !== defaults[key] ? zh ? " · 与默认不同" : " · Differs from default" : ""}</span>
            </div>
            <span className="permission-setting-toggle"><input type="checkbox" aria-label={accountPermissionLabels[key][languageIndex]} aria-describedby={`permission-description-${key}`} checked={values[key]} disabled={locked} onChange={event => { setError(""); setValues({ ...values, [key]: event.target.checked }); }} /><span>{values[key] ? zh ? "已开启" : "On" : zh ? "已关闭" : "Off"}</span></span>
          </div>;
        })}
        </div>
      </section>}

    </div>
    <footer>
      {error && <p className="account-access-error" role="alert">{error}</p>}
      <div className="permission-footer-actions"><button className="secondary-button" disabled={busy} onClick={confirming ? () => setConfirming(false) : dismiss}>{confirming ? zh ? "返回调整" : "Back to edit" : zh ? "取消" : "Cancel"}</button>
      {!administrator && <button className="primary-button" disabled={locked || !changes.length} onClick={confirming ? () => void submit() : () => setConfirming(true)}>{busy ? zh ? "保存中…" : "Saving…" : confirming ? zh ? "确认保存" : "Confirm save" : zh ? "核对变更" : "Review changes"}</button>}</div>
    </footer>
  </DialogSections></dialog>;
}

export default function AccountPermissionsPanel({ accounts, locale, canManage, refresh, toast }: { accounts: Row[]; locale: Locale; canManage: boolean; refresh: () => void; toast: (message: string) => void }) {
  const zh = locale === "zh";
  const [role, setRole] = useState("");
  const [status, setStatus] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const counts = accountRoleCounts(accounts);
  const needle = query.trim().toLowerCase();
  const filtered = accounts.filter(account => (!role || account.group === role) && (!status || account.status === status) && `${label(account.name)} ${label(account.email)}`.toLowerCase().includes(needle));
  const pages = Math.max(1, Math.ceil(filtered.length / 20));
  const current = Math.min(page, pages);
  const target = accounts.find(account => account.email === selected);
  if (!canManage) return <p role="alert">{zh ? "仅具有账号管理权限的管理员可查看与调整员工权限。" : "Only administrators with account management permission can view and edit employee permissions."}</p>;
  return <section className="account-permissions-panel" aria-label={zh ? "员工权限管理" : "Employee permission management"}>
    <DataList className="permissions-data-list admin-list-layout" ariaLabel={zh ? "员工权限管理" : "Employee permission management"} toolbar={<>
      <label className="page-search"><span aria-hidden="true"><SearchIcon /></span><input aria-label={zh ? "搜索权限账号" : "Search permission accounts"} placeholder={zh ? "搜索姓名或邮箱…" : "Search name or email…"} value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} /></label>
      <label className="admin-filter-field"><span>{zh ? "角色" : "Role"}</span><SelectControl locale={locale} aria-label={zh ? "权限角色筛选" : "Permission role filter"} value={role} onChange={event => { setRole(event.target.value); setPage(1); }}><option value="">{zh ? "全部角色" : "All roles"}</option>{accountRoles.map(item => <option key={item.key} value={item.key}>{item.name[zh ? 0 : 1]} · {counts[item.key]}</option>)}</SelectControl></label>
      <label className="admin-filter-field"><span>{zh ? "账号状态" : "Account status"}</span><SelectControl locale={locale} aria-label={zh ? "权限账号状态筛选" : "Permission account status filter"} value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}><option value="">{zh ? "全部状态" : "All statuses"}</option><option value="active">{zh ? "启用" : "Active"}</option><option value="disabled">{zh ? "已停用" : "Disabled"}</option></SelectControl></label>
      <div className="data-list-query-actions"><button className="secondary-button query-reset-button" onClick={() => { setRole(""); setStatus(""); setQuery(""); setPage(1); }}>{zh ? "重置筛选" : "Reset filters"}</button></div>
    </>} actions={<button className="secondary-button" onClick={refresh}>{zh ? "刷新权限" : "Refresh permissions"}</button>}
      summary={<strong>{role ? roleName(role, locale) : zh ? "全部账号" : "All accounts"} · {filtered.length}</strong>}
      pagination={<div className="account-access-pagination"><span>{zh ? `第 ${current} / ${pages} 页 · 共 ${filtered.length} 个账号` : `Page ${current} / ${pages} · ${filtered.length} accounts`}</span><button className="secondary-button" disabled={current <= 1} onClick={() => setPage(current - 1)}>{zh ? "上一页" : "Previous"}</button><button className="secondary-button" disabled={current >= pages} onClick={() => setPage(current + 1)}>{zh ? "下一页" : "Next"}</button></div>}>
      <DataListTable ariaLabel={zh ? "员工权限" : "Employee permissions"}><table className="work-table permission-account-table"><thead><tr>{[zh ? "姓名" : "Name", zh ? "邮箱" : "Email", zh ? "角色" : "Role", zh ? "账号状态" : "Account status", zh ? "权限范围" : "Permissions", zh ? "操作" : "Actions"].map(text => <th scope="col" key={text}>{text}</th>)}</tr></thead><tbody>
        {filtered.slice((current - 1) * 20, current * 20).map(account => <tr key={label(account.email)}><td><strong>{label(account.name)}</strong></td><td>{label(account.email)}</td><td>{roleName(account.group, locale)}</td><td>{account.status === "disabled" ? zh ? "已停用" : "Disabled" : zh ? "启用" : "Active"}</td><td><PermissionSummary account={account} locale={locale} /></td><td><button className="link-button" onClick={() => setSelected(label(account.email))}>{account.group === "system" ? zh ? "查看权限" : "View permissions" : zh ? "查看 / 调整权限" : "View / edit permissions"}</button></td></tr>)}
        {!filtered.length && <tr><td colSpan={6}>{zh ? "没有符合条件的账号，请更换角色或搜索条件。" : "No matching accounts. Change the role or search."}</td></tr>}
      </tbody></table></DataListTable>
    </DataList>
    {target && <PermissionDialog key={label(target.email)} account={target} locale={locale} close={() => setSelected(null)} saved={() => { setSelected(null); toast(zh ? "该员工的权限已保存。" : "This employee's permissions were saved."); refresh(); }} />}
  </section>;
}

function PermissionSummary({ account, locale }: { account: Row; locale: Locale }) {
  const zh = locale === "zh", { values, keys, disabled, differences } = accountPermissionSummary(account);
  if (!values) return <span>{zh ? "权限信息暂不可用" : "Permission information is unavailable"}</span>;
  return <div className="permission-list-summary">
    <strong>{zh ? `已开启 ${keys.length - disabled.length} / ${keys.length} 项` : `${keys.length - disabled.length} / ${keys.length} enabled`}</strong>
    <span className={differences?.length ? "permission-list-difference" : ""}>{differences === null ? zh ? "默认信息暂不可用" : "Default information is unavailable" : differences.length ? zh ? `与默认不同 ${differences.length} 项` : `${differences.length} differ from default` : zh ? "与角色默认一致" : "Matches role defaults"}</span>
    {disabled.length > 0 && <small>{zh ? "已关闭：" : "Off: "}{disabled.map(key => accountPermissionLabels[key][zh ? 0 : 1]).join(zh ? "、" : ", ")}</small>}
  </div>;
}
