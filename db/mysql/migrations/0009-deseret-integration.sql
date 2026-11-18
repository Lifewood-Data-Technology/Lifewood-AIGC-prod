-- Additive integration metadata. Existing business rows are preserved.
CREATE TABLE `deseret_project_links` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `deseret_project_id` VARCHAR(255) NOT NULL,
  `source_revision` LONGTEXT NOT NULL,
  `submission_version` BIGINT NOT NULL,
  `snapshot_json` LONGTEXT NOT NULL,
  `state_json` LONGTEXT NOT NULL,
  `native_video_ids` LONGTEXT NOT NULL,
  `native_task_ids` LONGTEXT NOT NULL,
  `revision` BIGINT NOT NULL,
  `created_by` VARCHAR(255) NOT NULL,
  `created_at` VARCHAR(255) NOT NULL,
  `updated_at` VARCHAR(255) NOT NULL,
  `__uq_idx_deseret_external_project` BINARY(32) GENERATED ALWAYS AS (CASE WHEN `deseret_project_id` IS NULL THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(`deseret_project_id`) AS CHAR CHARACTER SET utf8mb4),256)) END) STORED,
  UNIQUE KEY `idx_deseret_external_project` (`__uq_idx_deseret_external_project`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `deseret_inbox` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `sender` LONGTEXT NOT NULL,
  `project_id` VARCHAR(255),
  `payload_hash` VARCHAR(255) NOT NULL,
  `state` LONGTEXT NOT NULL,
  `response_json` LONGTEXT NOT NULL,
  `created_at` VARCHAR(255) NOT NULL,
  `updated_at` VARCHAR(255) NOT NULL,
  KEY `idx_deseret_inbox_project` (`project_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `deseret_outbox` (
  `id` VARCHAR(255) NOT NULL,
  `sequence` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `source_revision` LONGTEXT NOT NULL,
  `project_id` VARCHAR(255) NOT NULL,
  `event_type` LONGTEXT NOT NULL,
  `body_json` LONGTEXT NOT NULL,
  `state` LONGTEXT NOT NULL,
  `attempts` BIGINT NOT NULL,
  `lease_id` VARCHAR(255),
  `lease_expires_at` VARCHAR(255),
  `next_attempt_at` VARCHAR(255) NOT NULL,
  `last_error` LONGTEXT,
  `created_at` VARCHAR(255) NOT NULL,
  `updated_at` VARCHAR(255) NOT NULL,
  KEY `idx_deseret_outbox_pending` (`state`(191),`next_attempt_at`),
  KEY `idx_deseret_outbox_project` (`project_id`,`sequence`),
  `__uq_idx_deseret_outbox_id` BINARY(32) GENERATED ALWAYS AS (CASE WHEN `id` IS NULL THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(`id`) AS CHAR CHARACTER SET utf8mb4),256)) END) STORED,
  UNIQUE KEY `idx_deseret_outbox_id` (`__uq_idx_deseret_outbox_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `deseret_material_tasks` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `project_id` VARCHAR(255) NOT NULL,
  `source_revision` LONGTEXT NOT NULL,
  `file_id` VARCHAR(255) NOT NULL,
  `file_version` BIGINT NOT NULL,
  `manifest_json` LONGTEXT NOT NULL,
  `direction` LONGTEXT NOT NULL,
  `package_id` VARCHAR(255),
  `target_json` LONGTEXT,
  `state` LONGTEXT NOT NULL,
  `attempts` BIGINT NOT NULL,
  `last_error` LONGTEXT,
  `lease_id` VARCHAR(255),
  `lease_expires_at` VARCHAR(255),
  `next_attempt_at` VARCHAR(255) NOT NULL,
  `created_at` VARCHAR(255) NOT NULL,
  `updated_at` VARCHAR(255) NOT NULL,
  KEY `idx_deseret_material_project` (`project_id`,`source_revision`(191))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

--> statement-breakpoint
CREATE TABLE `deseret_handoff_history` (`id` VARCHAR(255) NOT NULL PRIMARY KEY, `project_id` VARCHAR(255) NOT NULL, `source_revision` LONGTEXT NOT NULL, `submission_version` BIGINT NOT NULL, `snapshot_json` LONGTEXT NOT NULL, `received_at` VARCHAR(255) NOT NULL, KEY `idx_deseret_history_project` (`project_id`,`submission_version`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
