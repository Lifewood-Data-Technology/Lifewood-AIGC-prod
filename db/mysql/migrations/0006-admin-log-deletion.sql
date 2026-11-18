-- Additive previews and minimal permanent-deletion receipts. Existing logs are not changed.
CREATE TABLE `admin_log_deletion_previews` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `actor_email` VARCHAR(254) NOT NULL,
  `target_kind` LONGTEXT NOT NULL,
  `ids_json` LONGTEXT NOT NULL,
  `summary_json` LONGTEXT NOT NULL,
  `record_count` BIGINT NOT NULL,
  `expires_at` VARCHAR(255) NOT NULL,
  `created_at` VARCHAR(255) NOT NULL,
  `consumed_submission_id` VARCHAR(255) NULL,
  KEY `idx_admin_log_previews_expiry` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `admin_log_deletion_receipts` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `preview_id` VARCHAR(255) NOT NULL,
  `actor_email` VARCHAR(254) NOT NULL,
  `target_kind` LONGTEXT NOT NULL,
  `deleted_count` BIGINT NOT NULL,
  `completed_at` VARCHAR(255) NOT NULL,
  UNIQUE KEY `idx_admin_log_receipts_preview` (`preview_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
