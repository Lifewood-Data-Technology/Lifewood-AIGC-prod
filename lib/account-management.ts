type Row = Record<string, unknown>;
export const accountRoles = [
  { key: "client", name: ["销售", "Sales"], description: ["新增和跟进自己的客户，负责客户预览、反馈与交付；不负责立项", "Create and follow up owned customers, previews, feedback and delivery; no project creation"] },
  { key: "project", name: ["项目负责人", "Project manager"], description: ["新增客户并指定销售、直接立项、管理需求、分配人员及管理业务项目", "Create customers with a sales owner, create projects directly, manage requirements and assignments"] },
  { key: "production", name: ["剪辑师", "Editor"], description: ["制作已分配的视频任务、提交质检并处理修改意见", "Produce assigned videos, submit for review and handle revisions"] },
  { key: "quality", name: ["质检员", "Reviewer"], description: ["审核已分配的视频任务，记录质检结果与修改意见", "Review assigned videos and record decisions and revision notes"] },
  { key: "system", name: ["管理员", "Administrator"], description: ["管理账号、权限、系统配置和操作日志，不参与业务项目操作", "Accounts, permissions, settings and audit logs; no business project operations"] },
] as const;

/** Count the public account DTO field, not the database column name. Includes disabled accounts. */
export function accountRoleCounts(accounts: Row[]) {
  return Object.fromEntries(accountRoles.map(role => [role.key, accounts.filter(account => account.group === role.key).length]));
}

export const accountPermissionLabels = {
  "customers.manage": ["客户资料管理", "Manage customers"],
  "requests.create": ["补充历史项目资料", "Update legacy project briefs"],
  "projects.manage": ["项目管理", "Manage projects"],
  "standards.manage": ["客户素材标准", "Manage client standards"],
  "files.upload": ["文件上传", "Upload files"],
  "assets.manage": ["素材库全局管理", "Manage all library assets"],
  "quality.review": ["质检决策", "Make quality decisions"],
  "delivery.manage": ["客户预览与交付", "Preview and delivery"],
  "accounts.manage": ["账号管理（管理员专用）", "Manage accounts (administrators only)"],
  "system.manage": ["系统配置（管理员专用）", "System settings (administrators only)"],
} as const;
export type AccountPermissionKey = keyof typeof accountPermissionLabels;
export const accountPermissionKeys = Object.keys(accountPermissionLabels) as AccountPermissionKey[];
export const isAdminPermission = (key: string) => key === "accounts.manage" || key === "system.manage";
// A permission enables a function inside a role; it must never create another role.
export const rolePermissionAllowlist: Record<string, readonly string[]> = {
  client: ["customers.manage", "requests.create", "files.upload", "delivery.manage"],
  project: ["customers.manage", "projects.manage", "standards.manage", "files.upload"],
  production: ["standards.manage", "files.upload", "assets.manage"],
  quality: ["files.upload", "quality.review"],
  system: ["accounts.manage", "system.manage"],
};
export const permissionAllowedForRole = (role: unknown, key: string) => Boolean(rolePermissionAllowlist[String(role)]?.includes(key));
export function accountPermissionValues(value: unknown): Record<AccountPermissionKey, boolean> | null {
  if (!value || typeof value !== "object" || accountPermissionKeys.some(key => typeof (value as Row)[key] !== "boolean")) return null;
  return Object.fromEntries(accountPermissionKeys.map(key => [key, (value as Row)[key]])) as Record<AccountPermissionKey, boolean>;
}

// Display guidance only. Authorization and data ownership remain server-enforced.
export const accountPermissionGuidance: Record<AccountPermissionKey, { purpose: readonly [string, string]; disabled: readonly [string, string] }> = {
  "customers.manage": {
    purpose: ["新增、维护职责范围内的客户资料；销售仅管理自己的客户。", "Create and maintain customers within the role's scope; sales manage their own customers only."],
    disabled: ["无法执行需要客户资料管理权限的新增、编辑操作。", "Customer creation and edits requiring this permission are unavailable."],
  },
  "requests.create": {
    purpose: ["补充本人负责的历史项目需求及附件，不授予立项权限。", "Update owned legacy project briefs and attachments; this does not allow project creation."],
    disabled: ["无法补充或调整需要此权限的历史项目资料与附件。", "Updates to legacy briefs and attachments requiring this permission are unavailable."],
  },
  "projects.manage": {
    purpose: ["在项目负责人职责范围内立项、维护需求并分配人员；仍受项目状态与交接规则约束。", "Create projects, maintain briefs and assign people within the project manager's scope; workflow and handover rules still apply."],
    disabled: ["无法执行需要项目管理权限的立项、分配及项目变更。", "Project creation, assignments and changes requiring this permission are unavailable."],
  },
  "standards.manage": {
    purpose: ["维护有权访问的客户素材标准；关联项目和任务的访问限制仍然适用。", "Maintain accessible client material standards; project and task access restrictions still apply."],
    disabled: ["无法新增或修改需要此权限的客户素材标准。", "Creating or editing client material standards requiring this permission is unavailable."],
  },
  "files.upload": {
    purpose: ["在角色允许的目录中上传文件并执行相关文件操作；不会扩大项目或任务的可见范围。", "Upload and perform related file operations in role-accessible folders; project and task visibility does not expand."],
    disabled: ["无法上传文件；依赖此权限的文件维护也会受限。", "Uploads are unavailable; file maintenance requiring this permission is also restricted."],
  },
  "assets.manage": {
    purpose: ["可维护素材库中其他人创建的素材与合集，仍需开启文件上传；不会获得所有业务项目的权限。", "Maintain library assets and collections created by other people. Upload files must also be enabled; this does not grant access to all business projects."],
    disabled: ["撤销对他人素材与合集的全局维护能力；仍可按原有归属规则维护自己的内容。", "Removes global maintenance of others' assets and collections; existing ownership rules still apply to personal content."],
  },
  "quality.review": {
    purpose: ["对分配给本人的待质检成片作出通过或退回决定。", "Approve or reject final cuts assigned to this reviewer and awaiting review."],
    disabled: ["无法提交需要质检决策权限的通过或退回结果。", "Approval or rejection decisions requiring this permission cannot be submitted."],
  },
  "delivery.manage": {
    purpose: ["为有权访问且符合流程条件的成片创建客户预览与交付链接。", "Create customer preview and delivery links for accessible final cuts that meet workflow conditions."],
    disabled: ["无法创建需要此权限的客户预览与交付链接；此开关不等同于撤回已有链接。", "Cannot create preview or delivery links requiring this permission; this switch does not itself revoke existing links."],
  },
  "accounts.manage": {
    purpose: ["管理账号及员工权限，仅管理员可用。", "Manage accounts and employee permissions; administrators only."],
    disabled: ["管理员权限受保护，此处只读。", "Administrator permissions are protected and read-only here."],
  },
  "system.manage": {
    purpose: ["管理系统配置并查看操作日志，仅管理员可用。", "Manage system settings and view audit logs; administrators only."],
    disabled: ["管理员权限受保护，此处只读。", "Administrator permissions are protected and read-only here."],
  },
};

export function accountPermissionSummary(account: Row) {
  const values = accountPermissionValues(account.permissions);
  const defaults = accountPermissionValues(account.permissionDefaults);
  const keys = accountPermissionKeys.filter(key => permissionAllowedForRole(account.group, key));
  return {
    values, defaults, keys,
    disabled: values ? keys.filter(key => !values[key]) : [],
    differences: values && defaults ? keys.filter(key => values[key] !== defaults[key]) : null,
  };
}

export function accountPermissionDisabledEffect(key: AccountPermissionKey, role: unknown): readonly [string, string] {
  if (key === "files.upload" && role === "production") return [
    "无法上传文件；依赖此权限的文件维护与成片提交质检也会受限。",
    "Uploads are unavailable; file maintenance and final-cut review submissions requiring this permission are also restricted.",
  ];
  return accountPermissionGuidance[key].disabled;
}
