/** Object scope only. Callers must also enforce current account capabilities and revisions. */
export function customerMaintenanceScope(actor: { access: string; email: string }, alias = "c") {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error("Invalid customer scope alias.");
  if (actor.access === "client")
    return { sql: `${alias}.owner_email = ?`, values: [actor.email] };
  if (actor.access === "project")
    return {
      sql: `${alias}.creator_maintenance_active = 1 AND ${alias}.created_by = (SELECT id FROM accounts WHERE email = ? AND access_group = 'project' AND status = 'active')`,
      values: [actor.email],
    };
  return { sql: "0 = 1", values: [] as string[] };
}
