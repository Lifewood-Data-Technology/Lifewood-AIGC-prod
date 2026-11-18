/** SQL expressions here are internal column references/placeholders, never user input. */
export function liveFolderSql(folderId: string) {
  return `EXISTS (
    WITH RECURSIVE ancestors(id, parent_folder_id, deleted_at) AS (
      SELECT id, parent_folder_id, deleted_at FROM aigc_folders WHERE id = ${folderId}
      UNION
      SELECT parent.id, parent.parent_folder_id, parent.deleted_at
      FROM aigc_folders parent JOIN ancestors child ON parent.id = child.parent_folder_id
    )
    SELECT COUNT(*) FROM ancestors
    HAVING COUNT(*) > 0 AND MAX(deleted_at IS NOT NULL) = 0
      AND MAX(parent_folder_id IS NULL) = 1
  )`;
}

export const folderDescendantsSql = `WITH RECURSIVE descendants(id) AS (
  SELECT id FROM aigc_folders WHERE id = ?
  UNION
  SELECT child.id FROM aigc_folders child JOIN descendants parent ON child.parent_folder_id = parent.id
) SELECT id FROM descendants`;

export function liveLogicalFileSql(alias: string) {
  return `${alias}.deleted_at IS NULL AND ${alias}.status <> 'deleted'
    AND ${liveFolderSql(`${alias}.folder_id`)}
    AND NOT EXISTS (
      SELECT 1 FROM asset_collection_files member
      JOIN asset_collections collection ON collection.id = member.collection_id
      WHERE member.file_id = ${alias}.id AND collection.status <> 'active'
    )`;
}
