"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { employeeDirectory, filterEmployeeDirectory } from "../lib/account-directory";
import type { ActiveDirectorySnapshot } from "../lib/admin-directory";
import { directoryTree } from "../lib/admin-directory-view";
import { workspaceFetch } from "../lib/tab-session";
import { DataListTable } from "./DataList";
import { MenuIcon } from "./MenuIcon";
import { SearchIcon } from "./ControlIcons";
import Pagination from "./TablePagination";

type UserRow = Record<string, unknown>;
type Props = {
  accounts: UserRow[];
  locale: "zh" | "en";
  busy: boolean;
  refreshKey: number;
  refresh: () => void;
  onCreate: () => void;
  onEdit: (account: UserRow) => void;
  roleLabel: (role: unknown) => string;
  dateLabel: (date: unknown) => string;
  renderStatus: (account: UserRow) => ReactNode;
  renderActions: (account: UserRow) => ReactNode;
};
const string = (value: unknown) => String(value ?? "");
const roles = ["client", "project", "production", "quality"] as const;
const csvCell = (value: string) => `"${(/^\s*[=+\-@]|^[\t\r\n]/.test(value) ? "'" : "") + value.replaceAll('"', '""')}"`;

/** Presentation and local filtering of the existing authorized account response.
 * All account mutations stay in AccountsPage with its confirmation/revision guards. */
export default function AdminUsersPanel({
  accounts, locale, busy, refreshKey, refresh, onCreate, onEdit, roleLabel, dateLabel, renderStatus, renderActions,
}: Props) {
  const zh = locale === "zh";
  const [directory, setDirectory] = useState<ActiveDirectorySnapshot | null>(null);
  const [organizationError, setOrganizationError] = useState("");
  const [organizationLoading, setOrganizationLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [department, setDepartment] = useState("");
  const [departmentQuery, setDepartmentQuery] = useState("");
  const [query, setQuery] = useState("");
  const [role, setRole] = useState("");
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState("default");
  const [showFilters, setShowFilters] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const selectPage = useRef<HTMLInputElement>(null);
  const employees = employeeDirectory(accounts);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      setOrganizationLoading(true);
      setOrganizationError("");
      try {
        const response = await workspaceFetch("/api/admin-directory", { cache: "no-store", signal: controller.signal });
        const result = await response.json() as { directory?: ActiveDirectorySnapshot };
        if (!response.ok || !Array.isArray(result.directory?.departments) || !Array.isArray(result.directory?.memberships)) throw Error("Organization unavailable");
        if (!controller.signal.aborted) setDirectory(result.directory);
      } catch {
        if (!controller.signal.aborted) {
          setDirectory(null);
          setOrganizationError(zh ? "组织机构读取失败，请重试。" : "Could not load departments. Please retry.");
        }
      } finally {
        if (!controller.signal.aborted) setOrganizationLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [reload, refreshKey, zh]);

  const membership = useMemo(() => new Map(directory?.memberships.map(item => [item.email, item.departmentId])), [directory]);
  const departmentId = (account: UserRow) => membership.has(string(account.email))
    ? membership.get(string(account.email)) || "" : string(account.departmentId);
  const departments = directory?.departments ?? [];
  const departmentName = (account: UserRow) => {
    if (!directory) return "—";
    const id = departmentId(account);
    return departments.find(item => item.id === id)?.name || (id ? (zh ? "部门不可用" : "Unavailable") : (zh ? "未分配部门" : "Unassigned"));
  };
  const filtered = filterEmployeeDirectory(employees, query, role, status).filter(account =>
    !department || (department === "__unassigned" ? !departmentId(account) : departmentId(account) === department));
  if (sort !== "default") filtered.sort((a, b) => {
    if (sort === "recent") return string(b.lastSignIn).localeCompare(string(a.lastSignIn));
    return string(a[sort]).localeCompare(string(b[sort]), locale);
  });
  const currentPage = Math.min(page, Math.max(1, Math.ceil(filtered.length / pageSize)));
  const visible = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  // Selections never survive outside the filtered, currently authorized dataset.
  const selectedRows = filtered.filter(account => selected.includes(string(account.email)));
  const allSelected = visible.length > 0 && visible.every(account => selected.includes(string(account.email)));
  useEffect(() => {
    if (selectPage.current) selectPage.current.indeterminate = !allSelected && visible.some(account => selected.includes(string(account.email)));
  }, [allSelected, selected, visible]);
  const resetSelection = () => { setPage(1); setSelected([]); };
  const reset = () => { setQuery(""); setRole(""); setStatus(""); setDepartment(""); setDepartmentQuery(""); setSort("default"); resetSelection(); };
  const reloadAccounts = () => { refresh(); setReload(value => value + 1); };

  const exportAccounts = () => {
    const records = selectedRows.length ? selectedRows : filtered;
    const headers = zh ? ["姓名", "邮箱", "角色", "部门", "状态", "密码状态", "最近登录"] : ["Name", "Email", "Role", "Department", "Status", "Password status", "Last sign-in"];
    const rows = records.map(account => [string(account.name), string(account.email), roleLabel(account.group), departmentName(account),
      account.status === "disabled" ? (zh ? "停用" : "Disabled") : (zh ? "启用" : "Active"),
      account.mustChangePassword ? (zh ? "等待首次修改" : "Change required") : (zh ? "已设置" : "Set"), dateLabel(account.lastSignIn)]);
    const csv = "\uFEFF" + [headers, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url; link.download = "employees.csv"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const departmentEntries = directoryTree(departments);

  return <section className="admin-users-workspace employee-accounts-panel" aria-label={zh ? "员工账号" : "Employee accounts"}>
    <aside className="admin-users-organization" aria-label={zh ? "组织机构" : "Organization"}>
      <h2>{zh ? "组织机构" : "Organization"}</h2>
      <label className="admin-users-department-search">
        <SearchIcon />
        <input aria-label={zh ? "搜索部门" : "Search departments"} placeholder={zh ? "请输入部门名称" : "Department name"} value={departmentQuery} onChange={event => setDepartmentQuery(event.target.value)} />
      </label>
      <div className="admin-users-departments" aria-busy={organizationLoading}>
        <button className={!department ? "selected" : ""} aria-pressed={!department} onClick={() => { setDepartment(""); resetSelection(); }}>
          <MenuIcon name="departments" /><span>{zh ? "全部部门" : "All departments"}</span><small>{employees.length}</small>
        </button>
        {organizationLoading && !directory && <p role="status">{zh ? "正在加载…" : "Loading…"}</p>}
        {organizationError && <div className="admin-users-org-error" role="alert"><p>{organizationError}</p><button onClick={() => setReload(value => value + 1)}>{zh ? "重试" : "Retry"}</button></div>}
        {directory && <>
          {departmentEntries.filter(({record}) => record.name.toLowerCase().includes(departmentQuery.trim().toLowerCase())).map(({record:item, depth}) =>
            <button key={item.id} className={department === item.id ? "selected" : ""} aria-pressed={department === item.id} title={item.name} style={{ paddingInlineStart: 10 + Math.min(depth, 4) * 12 }} onClick={() => { setDepartment(item.id); resetSelection(); }}>
              <MenuIcon name="files" /><span>{item.name}</span><small>{employees.filter(account => departmentId(account) === item.id).length}</small>
            </button>)}
          {!departmentEntries.length && <p>{zh ? "尚未设置部门" : "No departments configured"}</p>}
          {departmentEntries.length > 0 && departmentQuery && !departmentEntries.some(({record}) => record.name.toLowerCase().includes(departmentQuery.trim().toLowerCase())) && <p>{zh ? "没有匹配的部门" : "No matching departments"}</p>}
          <button className={department === "__unassigned" ? "selected" : ""} aria-pressed={department === "__unassigned"} onClick={() => { setDepartment("__unassigned"); resetSelection(); }}>
            <MenuIcon name="users" /><span>{zh ? "未分配部门" : "Unassigned"}</span><small>{employees.filter(account => !departmentId(account)).length}</small>
          </button>
        </>}
      </div>
    </aside>
    <div className="admin-users-content">
      <form className="admin-users-filters" hidden={!showFilters} onSubmit={event => { event.preventDefault(); setPage(1); }}>
        <label><span>{zh ? "名称 / 邮箱" : "Name / email"}</span><input aria-label={zh ? "搜索账号" : "Search accounts"} placeholder={zh ? "输入关键词" : "Enter keywords"} value={query} onChange={event => { setQuery(event.target.value); resetSelection(); }} /></label>
        <label><span>{zh ? "角色" : "Role"}</span><select value={role} onChange={event => { setRole(event.target.value); resetSelection(); }}><option value="">{zh ? "全部" : "All"}</option>{roles.map(value => <option key={value} value={value}>{roleLabel(value)}</option>)}</select></label>
        <label><span>{zh ? "状态" : "Status"}</span><select value={status} onChange={event => { setStatus(event.target.value); resetSelection(); }}><option value="">{zh ? "全部" : "All"}</option><option value="active">{zh ? "启用" : "Active"}</option><option value="disabled">{zh ? "停用" : "Disabled"}</option></select></label>
        <div className="admin-users-query-actions"><button className="primary-button" type="submit"><SearchIcon />{zh ? "搜索" : "Search"}</button><button className="secondary-button" type="button" onClick={reset}>{zh ? "重置" : "Reset"}</button></div>
      </form>
      <div className="admin-users-tools">
        <div className="admin-users-edit-tools">
          <button className="admin-users-add" disabled={busy} onClick={onCreate}>＋ {zh ? "新增" : "Add user"}</button>
          <button disabled={busy || selectedRows.length !== 1} onClick={() => onEdit(selectedRows[0])}>{zh ? "修改" : "Edit"}</button>
          <button className="admin-users-export" disabled={!filtered.length} onClick={exportAccounts}>{selectedRows.length ? (zh ? "导出所选" : "Export selected") : (zh ? "导出筛选" : "Export filtered")}</button>
        </div>
        <div className="admin-users-view-tools">
          <button className="admin-users-icon-button" title={zh ? "显示 / 隐藏筛选" : "Show / hide filters"} aria-label={zh ? "显示 / 隐藏筛选" : "Show / hide filters"} aria-expanded={showFilters} onClick={() => setShowFilters(value => !value)}><SearchIcon /></button>
          <button className="admin-users-icon-button" title={zh ? "刷新" : "Refresh"} aria-label={zh ? "刷新" : "Refresh"} disabled={organizationLoading} onClick={reloadAccounts}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M20 7v5h-5M20 12a8 8 0 1 0-2 5M20 7l-2 2" /></svg></button>
          <label><span>{zh ? "排序" : "Sort"}</span><select value={sort} onChange={event => { setSort(event.target.value); setPage(1); }}><option value="default">{zh ? "默认顺序" : "Default"}</option><option value="name">{zh ? "姓名" : "Name"}</option><option value="email">{zh ? "邮箱" : "Email"}</option><option value="recent">{zh ? "最近登录" : "Last sign-in"}</option></select></label>
        </div>
      </div>
      <DataListTable className="admin-users-table-scroll" ariaLabel={zh ? "员工账号表格" : "Employee accounts table"}>
        <table className="work-table employee-accounts-table">
          <thead><tr>
            <th scope="col" className="check-column"><input ref={selectPage} type="checkbox" aria-label={zh ? "选择当前页" : "Select current page"} checked={allSelected} disabled={!visible.length} onChange={event => setSelected(event.target.checked ? [...new Set([...selected, ...visible.map(account => string(account.email))])] : selected.filter(email => !visible.some(account => account.email === email)))} /></th>
            {(zh ? ["姓名", "邮箱", "角色", "部门", "状态", "密码状态", "最近登录", "操作"] : ["Name", "Email", "Role", "Department", "Status", "Password status", "Last sign-in", "Actions"]).map(label => <th scope="col" key={label}>{label}</th>)}
          </tr></thead>
          <tbody>{visible.map(account => <tr key={string(account.email)} className={selected.includes(string(account.email)) ? "is-selected" : ""}>
            <td className="check-column"><input type="checkbox" aria-label={`${zh ? "选择" : "Select"} ${string(account.name)} (${string(account.email)})`} checked={selected.includes(string(account.email))} onChange={event => setSelected(event.target.checked ? [...selected, string(account.email)] : selected.filter(email => email !== account.email))} /></td>
            <td><strong title={string(account.name)}>{string(account.name)}</strong></td>
            <td className="account-email-cell"><span title={string(account.email)}>{string(account.email)}</span></td>
            <td><span title={roleLabel(account.group)}>{roleLabel(account.group)}</span></td>
            <td><span title={departmentName(account)}>{departmentName(account)}</span></td>
            <td>{renderStatus(account)}</td>
            <td><span className={`password-state ${account.mustChangePassword ? "pending" : "ready"}`} title={account.mustChangePassword ? (zh ? "等待首次修改" : "Change required") : (zh ? "已设置" : "Set")}>{account.mustChangePassword ? (zh ? "等待首次修改" : "Change required") : (zh ? "已设置" : "Set")}</span></td>
            <td>{dateLabel(account.lastSignIn)}</td>
            <td>{renderActions(account)}</td>
          </tr>)}
          {!filtered.length && <tr><td colSpan={9} className="table-empty-cell">{zh ? (employees.length ? "没有符合筛选条件的员工账号。" : "还没有员工账号，可点击“新增”添加。") : (employees.length ? "No employees match these filters." : "No employee accounts yet. Select Add user to create one.")}</td></tr>}
          </tbody>
        </table>
      </DataListTable>
      <div className="admin-users-pagination">
        <span aria-live="polite">{zh ? `已选 ${selectedRows.length} 项` : `${selectedRows.length} selected`}</span>
        <Pagination locale={locale} page={currentPage} pageSize={pageSize} total={filtered.length} onPage={setPage} onPageSize={size => { setPageSize(size); setPage(1); }} />
      </div>
    </div>
  </section>;
}
