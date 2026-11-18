type Row = Record<string, unknown>;
export const teamRoles = ["client", "project", "production", "quality"];
export function teamDirectory(team: Row[], query = "", role = "", workload = false) {
  const search = query.trim().toLocaleLowerCase();
  return team.filter(person => teamRoles.includes(String(person.access_group)) && person.status === "active" &&
    (!workload || ["production", "quality"].includes(String(person.access_group))) &&
    (!role || person.access_group === role) && `${person.name} ${person.email}`.toLocaleLowerCase().includes(search))
    .sort((a, b) => workload ? activeWork(b) - activeWork(a) || String(a.name).localeCompare(String(b.name)) : String(a.name).localeCompare(String(b.name)));
}
export function activeWork(person: Row) { return Number(person.access_group === "production" ? person.editor_active_count : person.reviewer_active_count) || 0; }
export function currentProjectAssignments(person: Row, tasks: Row[], projectId: string) {
  return tasks.filter(task => task.project_id === projectId && !["已交付", "已归档", "已终止"].includes(String(task.status)) &&
    (person.access_group === "production" ? task.editor_email === person.email : person.access_group === "quality" && task.reviewer_email === person.email));
}
