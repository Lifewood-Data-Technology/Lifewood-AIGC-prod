/** Compatibility for old bookmarks only; these views are not active menu routes. */
export function resolveAdminView(view: string) {
  if (view === "settings") return { view: "security", retired: false };
  if (view === "positions") return { view: "dashboard", retired: true };
  return { view, retired: false };
}

export function activeAdminTabs(ids: string[]) {
  return Array.from(new Set(ids.map(id => resolveAdminView(id).view)));
}
