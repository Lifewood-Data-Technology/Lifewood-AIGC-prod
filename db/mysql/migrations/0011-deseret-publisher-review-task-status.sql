-- Data repair only; no table, column, index or guard changes.
-- Deseret language tasks published or returned before the publisher-review status fix kept the native "制作中".
-- The repair runs in one transaction and changes only tasks whose state is still unambiguous:
--   * latest non-withdrawn publication of the task has no conclusion (publisher review pending),
--     project stage storyboard_review/final_review                                     -> 待客户预览
--   * latest non-withdrawn publication of the task was returned for one of its scenes (scene id still in
--     revisionSceneIds; a final can also be returned after approval by author feedback),
--     project stage revision/production/final_production                                -> 客户要求修改
-- Every repaired task is "制作中" now and has no quality round or final submission after that publication.
-- Re-produced and re-reviewed tasks, paused or closed tasks, ordinary projects, deleted or archived projects,
-- projects under business deletion, delivery-locked integrations and unreturned language tasks are unchanged.
-- Anything not covered stays with the runtime display. Affected project summaries are recalculated with the
-- application's existing project summary rules.
SET @lifewood_m0011_at = CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3),'%Y-%m-%dT%H:%i:%s.'),LEFT(DATE_FORMAT(UTC_TIMESTAMP(3),'%f'),3),'Z'),
    @lifewood_m0011_marker = CONCAT('migration-0011-', UUID())
--> statement-breakpoint
START TRANSACTION
--> statement-breakpoint
UPDATE `language_projects` lp
JOIN `projects` p ON p.id = lp.project_id
JOIN (
  SELECT latest.project_id, latest.task_id,
    CASE
      WHEN latest.conclusion IS NULL AND latest.stage IN ('storyboard_review','final_review') THEN '待客户预览'
      WHEN latest.returned = 1 AND latest.stage IN ('revision','production','final_production')
        AND (latest.conclusion = 'revision' OR (latest.conclusion = 'approved' AND latest.phase = 'final')) THEN '客户要求修改'
    END AS next_status
  FROM (
    SELECT task_rows.*, MAX(task_rows.ord) OVER (PARTITION BY task_rows.project_id, task_rows.task_id) AS latest_ord
    FROM (
      SELECT pkg.project_id, pkg.stage, pkg.locked, pkg.ord, pkg.phase, pkg.conclusion, pkg.published_at,
        COALESCE(pkg.file_task, pkg.scene_task) AS task_id,
        MAX(pkg.file_task IS NOT NULL) AS published,
        MAX(pkg.scene_task IS NOT NULL AND COALESCE(JSON_CONTAINS(pkg.revision_scene_ids, JSON_QUOTE(pkg.scene_id)), 0) = 1) AS returned
      FROM (
        SELECT l.id AS project_id,
          JSON_UNQUOTE(JSON_EXTRACT(CASE WHEN JSON_VALID(l.state_json) THEN l.state_json ELSE '{}' END, '$.stage')) AS stage,
          COALESCE(JSON_EXTRACT(CASE WHEN JSON_VALID(l.state_json) THEN l.state_json ELSE '{}' END, '$.deliveryLocked') = CAST('true' AS JSON), 0) AS locked,
          JSON_EXTRACT(CASE WHEN JSON_VALID(l.state_json) THEN l.state_json ELSE '{}' END, '$.revisionSceneIds') AS revision_scene_ids,
          item.ord, item.phase, item.withdrawn, item.conclusion, item.published_at,
          item.file_task, item.scene_id, item.scene_task
        FROM `deseret_project_links` l,
        JSON_TABLE(CASE WHEN JSON_VALID(l.state_json) THEN l.state_json ELSE '{}' END, '$.packages[*]' COLUMNS (
          ord FOR ORDINALITY,
          phase VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin PATH '$.phase',
          withdrawn JSON PATH '$.withdrawn',
          conclusion VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin PATH '$.conclusion',
          published_at VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin PATH '$.publishedAt',
          NESTED PATH '$.files[*]' COLUMNS (
            file_task VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin PATH '$.languageTaskId'
          ),
          NESTED PATH '$.scenes[*]' COLUMNS (
            scene_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin PATH '$.id',
            scene_task VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin PATH '$.languageTaskId'
          )
        )) item
      ) pkg
      WHERE COALESCE(pkg.withdrawn = CAST('true' AS JSON), 0) = 0
        AND COALESCE(pkg.file_task, pkg.scene_task) IS NOT NULL
      GROUP BY pkg.project_id, pkg.stage, pkg.locked, pkg.ord, pkg.phase, pkg.conclusion, pkg.published_at, COALESCE(pkg.file_task, pkg.scene_task)
      HAVING MAX(pkg.file_task IS NOT NULL) = 1
    ) task_rows
  ) latest
  WHERE latest.ord = latest.latest_ord
    AND latest.locked = 0
    AND latest.published_at REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    AND NOT EXISTS (SELECT 1 FROM `quality_rounds` q WHERE q.language_project_id = latest.task_id AND q.created_at > latest.published_at)
    AND NOT EXISTS (SELECT 1 FROM `production_final_submissions` s WHERE s.language_project_id = latest.task_id AND s.submitted_at > latest.published_at)
) repair ON repair.task_id = lp.id AND repair.project_id = lp.project_id
SET lp.status = repair.next_status,
  lp.updated_at = @lifewood_m0011_marker COLLATE utf8mb4_0900_bin,
  lp.revision = lp.revision + 1
WHERE repair.next_status IS NOT NULL
  AND lp.status = '制作中'
  AND p.deleted_at IS NULL
  AND p.status NOT IN ('已暂停', '已交付', '已归档', '已终止')
  AND NOT EXISTS (SELECT 1 FROM `business_deletion_locks` bdl WHERE bdl.scope_id = CONCAT('project:', p.id))
--> statement-breakpoint
UPDATE `projects` SET
  status = CASE
    WHEN status = '已归档' THEN '已归档'
    WHEN NOT EXISTS (SELECT 1 FROM language_projects WHERE language_projects.project_id = projects.id) THEN status
    WHEN NOT EXISTS (SELECT 1 FROM language_projects WHERE language_projects.project_id = projects.id AND status <> '已终止') THEN '已终止'
    WHEN NOT EXISTS (SELECT 1 FROM language_projects WHERE language_projects.project_id = projects.id AND status NOT IN ('已归档', '已终止')) THEN '已归档'
    WHEN NOT EXISTS (SELECT 1 FROM language_projects WHERE language_projects.project_id = projects.id AND status NOT IN ('已交付', '已归档', '已终止')) THEN '已交付'
    WHEN EXISTS (SELECT 1 FROM language_projects WHERE language_projects.project_id = projects.id AND status = '质检驳回') THEN '质检驳回'
    WHEN EXISTS (SELECT 1 FROM language_projects WHERE language_projects.project_id = projects.id AND status = '客户要求修改') THEN '客户要求修改'
    WHEN EXISTS (SELECT 1 FROM language_projects WHERE language_projects.project_id = projects.id AND status IN ('待补充资料', '待分配')) THEN '待分配'
    WHEN EXISTS (SELECT 1 FROM language_projects WHERE language_projects.project_id = projects.id AND status = '制作中') THEN '制作中'
    WHEN EXISTS (SELECT 1 FROM language_projects WHERE language_projects.project_id = projects.id AND status = '待质检') THEN '待质检'
    WHEN EXISTS (SELECT 1 FROM language_projects WHERE language_projects.project_id = projects.id AND status = '待最终确认') THEN '待最终确认'
    WHEN EXISTS (SELECT 1 FROM language_projects WHERE language_projects.project_id = projects.id AND status = '待客户预览') THEN '待客户预览'
    WHEN EXISTS (SELECT 1 FROM language_projects WHERE language_projects.project_id = projects.id AND status = '待交付') THEN '待交付'
    WHEN EXISTS (SELECT 1 FROM language_projects WHERE language_projects.project_id = projects.id AND status = '已暂停') THEN '已暂停'
    ELSE status END,
  editor_email = CASE WHEN EXISTS (SELECT 1 FROM language_projects WHERE language_projects.project_id = projects.id) THEN (SELECT group_concat(DISTINCT editor_email) FROM language_projects WHERE language_projects.project_id = projects.id AND editor_email IS NOT NULL AND trim(editor_email) <> '') ELSE editor_email END,
  reviewer_email = CASE WHEN EXISTS (SELECT 1 FROM language_projects WHERE language_projects.project_id = projects.id) THEN (SELECT group_concat(DISTINCT reviewer_email) FROM language_projects WHERE language_projects.project_id = projects.id AND reviewer_email IS NOT NULL AND trim(reviewer_email) <> '') ELSE reviewer_email END,
  updated_at = @lifewood_m0011_at COLLATE utf8mb4_0900_bin,
  revision = revision + 1
WHERE projects.id IN (
  SELECT changed.project_id FROM (
    SELECT DISTINCT lp.project_id FROM `language_projects` lp
    WHERE lp.updated_at = @lifewood_m0011_marker COLLATE utf8mb4_0900_bin AND lp.status IN ('待客户预览', '客户要求修改')
  ) changed
)
--> statement-breakpoint
UPDATE `language_projects` SET updated_at = @lifewood_m0011_at COLLATE utf8mb4_0900_bin
WHERE updated_at = @lifewood_m0011_marker COLLATE utf8mb4_0900_bin
--> statement-breakpoint
COMMIT
