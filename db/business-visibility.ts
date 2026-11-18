/** Internal SQL aliases/expressions only. Callers must never pass request input. */
export function businessUnlockedSql(kind: "customer" | "project", id: string) {
  return `NOT EXISTS (SELECT 1 FROM business_deletion_locks lifecycle_lock WHERE lifecycle_lock.scope_id = '${kind}:' || ${id})`;
}

export function visibleCustomerSql(alias: string) {
  return `${alias}.deleted_at IS NULL AND ${businessUnlockedSql("customer", `${alias}.id`)}`;
}

export function visibleProjectSql(alias: string) {
  return `${alias}.deleted_at IS NULL AND ${businessUnlockedSql("project", `${alias}.id`)} AND EXISTS (SELECT 1 FROM clients lifecycle_client WHERE lifecycle_client.id = ${alias}.client_id AND ${visibleCustomerSql("lifecycle_client")})`;
}

export function visibleRequestSql(alias: string) {
  return `EXISTS (SELECT 1 FROM clients lifecycle_client WHERE lifecycle_client.id = ${alias}.client_id AND ${visibleCustomerSql("lifecycle_client")}) AND (NULLIF(${alias}.project_id, '') IS NULL OR EXISTS (SELECT 1 FROM projects lifecycle_project WHERE lifecycle_project.id = ${alias}.project_id AND ${visibleProjectSql("lifecycle_project")}))`;
}
