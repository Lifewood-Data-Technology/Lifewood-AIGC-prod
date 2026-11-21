-- Internal Deseret production continuity records. Additive only; existing rows and daily reports are unchanged.
-- None of these tables is ever serialized into publisher events, material transfers or integration state.
CREATE TABLE `deseret_production_archives` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `project_id` VARCHAR(255) NOT NULL,
  `language_project_id` VARCHAR(255) NOT NULL,
  `archive_number` BIGINT NOT NULL,
  `created_by_email` VARCHAR(254) NOT NULL,
  `next_steps` LONGTEXT NOT NULL,
  `created_at` VARCHAR(255) NOT NULL,
  `__uq_idx_deseret_archive_number` BINARY(32) GENERATED ALWAYS AS (CASE WHEN `language_project_id` IS NULL OR `archive_number` IS NULL THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(`language_project_id`,`archive_number`) AS CHAR CHARACTER SET utf8mb4),256)) END) STORED,
  UNIQUE KEY `idx_deseret_archive_number` (`__uq_idx_deseret_archive_number`),
  KEY `idx_deseret_archive_project` (`project_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `deseret_archive_files` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `archive_id` VARCHAR(255) NOT NULL,
  `language_project_id` VARCHAR(255) NOT NULL,
  `file_version_id` VARCHAR(255) NOT NULL,
  `role` LONGTEXT NOT NULL,
  `created_at` VARCHAR(255) NOT NULL,
  `__uq_idx_deseret_archive_file` BINARY(32) GENERATED ALWAYS AS (CASE WHEN `archive_id` IS NULL OR `file_version_id` IS NULL THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(`archive_id`,`file_version_id`) AS CHAR CHARACTER SET utf8mb4),256)) END) STORED,
  UNIQUE KEY `idx_deseret_archive_file` (`__uq_idx_deseret_archive_file`),
  KEY `idx_deseret_archive_file_version` (`file_version_id`),
  KEY `idx_deseret_archive_file_task` (`language_project_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `deseret_package_sources` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `project_id` VARCHAR(255) NOT NULL,
  `package_id` VARCHAR(255) NOT NULL,
  `scene_id` VARCHAR(255) NOT NULL,
  `scene_version` BIGINT NOT NULL,
  `language_project_id` VARCHAR(255) NOT NULL,
  `video_version_id` VARCHAR(255) NOT NULL,
  `archive_id` VARCHAR(255) NOT NULL,
  `confirmed_by_email` VARCHAR(254) NOT NULL,
  `created_at` VARCHAR(255) NOT NULL,
  `__uq_idx_deseret_package_scene` BINARY(32) GENERATED ALWAYS AS (CASE WHEN `package_id` IS NULL OR `scene_id` IS NULL THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(`package_id`,`scene_id`) AS CHAR CHARACTER SET utf8mb4),256)) END) STORED,
  UNIQUE KEY `idx_deseret_package_scene` (`__uq_idx_deseret_package_scene`),
  KEY `idx_deseret_package_source_project` (`project_id`),
  KEY `idx_deseret_package_source_archive` (`archive_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `deseret_task_handovers` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `handover_id` VARCHAR(255) NOT NULL,
  `project_id` VARCHAR(255) NOT NULL,
  `language_project_id` VARCHAR(255) NOT NULL,
  `handover_kind` LONGTEXT NOT NULL,
  `from_editor_email` VARCHAR(254) NOT NULL,
  `to_editor_email` VARCHAR(254) NOT NULL,
  `archive_id` VARCHAR(255),
  `verification` LONGTEXT NOT NULL,
  `verification_notes` LONGTEXT NOT NULL,
  `verified_by_email` VARCHAR(254),
  `verified_at` VARCHAR(255),
  `created_at` VARCHAR(255) NOT NULL,
  `__uq_idx_deseret_task_handover` BINARY(32) GENERATED ALWAYS AS (CASE WHEN `handover_id` IS NULL THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(`handover_id`) AS CHAR CHARACTER SET utf8mb4),256)) END) STORED,
  UNIQUE KEY `idx_deseret_task_handover` (`__uq_idx_deseret_task_handover`),
  KEY `idx_deseret_task_handover_task` (`language_project_id`),
  KEY `idx_deseret_task_handover_project` (`project_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
