/** Query menus align to the visible field; edit forms retain their own trigger. */
export function queryControlAnchor(trigger: HTMLElement): HTMLElement {
  if (trigger.closest('.pm-filters')) return trigger;
  const field = trigger.closest<HTMLElement>('label, .admin-filter-field, .query-inline-field, .editor-filter-field, .editor-status-filter');
  return field && field.closest('.filter-group, .dashboard-filters, .admin-filters, .editor-task-filters, .query-inline-field') ? field : trigger;
}
