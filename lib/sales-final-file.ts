type SalesFile = Record<string, unknown>;

export const salesFinalStatuses = ["qc_approved", "customer_revision_requested", "final", "delivered"] as const;
export const salesPreviewStatuses = ["qc_approved", "customer_revision_requested", "final"] as const;
export const salesDeliveryStatuses = ["qc_approved", "final", "delivered"] as const;

/** Select a video final from the authorized files; independent audio is never the final video. */
export function salesFinalFile<T extends SalesFile>(files: readonly T[], languageId: string, statuses: readonly string[] = salesFinalStatuses): T | undefined {
  return files.filter(file =>
    String(file.language_project_id ?? "") === languageId &&
    String(file.mime_type ?? "").startsWith("video/") &&
    statuses.includes(String(file.status ?? "")),
  ).sort((left, right) => Number(right.version || 0) - Number(left.version || 0))[0];
}
