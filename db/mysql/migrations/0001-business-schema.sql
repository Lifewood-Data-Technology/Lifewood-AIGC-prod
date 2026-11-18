-- Structure only; no source data, demo seeds, or destructive statements.
CREATE TABLE `account_credentials` (
  `email` VARCHAR(254) NOT NULL PRIMARY KEY,
  `password_hash` VARCHAR(255) NOT NULL,
  `password_salt` VARCHAR(255) NOT NULL,
  `iterations` BIGINT NOT NULL,
  `updated_at` VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `account_login_history` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `account_email` VARCHAR(254) NOT NULL,
  `occurred_at` VARCHAR(255) NOT NULL,
  `event` LONGTEXT NOT NULL,
  `ip_address` LONGTEXT NOT NULL DEFAULT (''),
  `browser` LONGTEXT NOT NULL DEFAULT (''),
  `os` LONGTEXT NOT NULL DEFAULT (''),
  KEY `idx_account_login_history_email_time` (`account_email`,`occurred_at`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `account_login_intents` (
  `token_hash` VARCHAR(255) NOT NULL PRIMARY KEY,
  `tab_hash` VARCHAR(255) NOT NULL,
  `expires_at` VARCHAR(255) NOT NULL,
  `state` LONGTEXT NOT NULL DEFAULT ('ended')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `account_mfa` (
  `account_email` VARCHAR(254) NOT NULL PRIMARY KEY,
  `secret_enc` LONGTEXT NOT NULL,
  `generation` LONGTEXT NOT NULL,
  `enabled_at` VARCHAR(255) NOT NULL DEFAULT (''),
  `pending_expires_at` VARCHAR(255) NOT NULL DEFAULT (''),
  `last_counter` BIGINT NOT NULL DEFAULT (-1),
  `recovery_hashes` LONGTEXT NOT NULL DEFAULT ('[]')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `account_permissions` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `account_email` VARCHAR(254) NOT NULL,
  `permission_key` LONGTEXT NOT NULL,
  `allowed` BIGINT NOT NULL,
  `updated_by` VARCHAR(255) NOT NULL,
  `updated_at` VARCHAR(255) NOT NULL,
  `__uq_idx_account_permissions_account_key` BINARY(32) GENERATED ALWAYS AS (CASE WHEN `account_email` IS NULL OR `permission_key` IS NULL THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(`account_email`,`permission_key`) AS CHAR CHARACTER SET utf8mb4),256)) END) STORED,
  UNIQUE KEY `idx_account_permissions_account_key` (`__uq_idx_account_permissions_account_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `account_presence` (
  `token_hash` VARCHAR(255) NOT NULL PRIMARY KEY,
  `account_email` VARCHAR(254) NOT NULL,
  `login_ip` LONGTEXT NOT NULL DEFAULT (''),
  `current_ip` LONGTEXT NOT NULL DEFAULT (''),
  `browser` LONGTEXT NOT NULL DEFAULT (''),
  `os` LONGTEXT NOT NULL DEFAULT (''),
  `last_contact_at` VARCHAR(255) NOT NULL,
  `last_activity_at` VARCHAR(255),
  `visible` BIGINT NOT NULL DEFAULT (0),
  KEY `idx_account_presence_email` (`account_email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `account_sessions` (
  `token_hash` VARCHAR(255) NOT NULL PRIMARY KEY,
  `account_email` VARCHAR(254) NOT NULL,
  `expires_at` VARCHAR(255) NOT NULL,
  `created_at` VARCHAR(255) NOT NULL,
  `last_seen_at` VARCHAR(255) NOT NULL,
  `tab_hash` VARCHAR(255) NOT NULL DEFAULT (''),
  `tab_released_at` VARCHAR(255) NOT NULL DEFAULT (''),
  `browser_key_hash` VARCHAR(255) NOT NULL DEFAULT (''),
  `revoked_reason` LONGTEXT NOT NULL DEFAULT ('policy_upgrade'),
  `__uq_idx_account_sessions_one_active` BINARY(32) GENERATED ALWAYS AS (CASE WHEN NOT (`account_sessions`.`revoked_reason` = '') OR `account_email` IS NULL THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(`account_email`) AS CHAR CHARACTER SET utf8mb4),256)) END) STORED,
  UNIQUE KEY `idx_account_sessions_one_active` (`__uq_idx_account_sessions_one_active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `accounts` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `email` VARCHAR(254) NOT NULL,
  `password_hash` VARCHAR(255) NOT NULL,
  `name` LONGTEXT NOT NULL,
  `initials` LONGTEXT NOT NULL,
  `access_group` LONGTEXT NOT NULL,
  `status` LONGTEXT NOT NULL DEFAULT ('active'),
  `management_revision` BIGINT NOT NULL DEFAULT (1),
  `must_change_password` BIGINT NOT NULL DEFAULT (false),
  `last_sign_in` LONGTEXT,
  `created_at` VARCHAR(255) NOT NULL,
  `__uq_accounts_email_unique` BINARY(32) GENERATED ALWAYS AS (CASE WHEN `email` IS NULL THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(`email`) AS CHAR CHARACTER SET utf8mb4),256)) END) STORED,
  UNIQUE KEY `accounts_email_unique` (`__uq_accounts_email_unique`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `aigc_file_operations` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `file_id` VARCHAR(255),
  `folder_id` VARCHAR(255),
  `operation` LONGTEXT NOT NULL,
  `actor_email` VARCHAR(254) NOT NULL,
  `details` LONGTEXT NOT NULL,
  `created_at` VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `aigc_file_previews` (
  `file_version_id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `object_key` LONGTEXT NOT NULL,
  `mime_type` LONGTEXT NOT NULL,
  `size_bytes` BIGINT NOT NULL,
  `width` BIGINT,
  `height` BIGINT,
  `created_by` VARCHAR(255) NOT NULL,
  `created_at` VARCHAR(255) NOT NULL,
  `updated_at` VARCHAR(255) NOT NULL,
  `__uq_aigc_file_previews_object_key_unique` BINARY(32) GENERATED ALWAYS AS (CASE WHEN `object_key` IS NULL THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(`object_key`) AS CHAR CHARACTER SET utf8mb4),256)) END) STORED,
  UNIQUE KEY `aigc_file_previews_object_key_unique` (`__uq_aigc_file_previews_object_key_unique`),
  KEY `idx_aigc_file_previews_updated` (`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `aigc_file_versions` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `file_id` VARCHAR(255) NOT NULL,
  `version_number` BIGINT NOT NULL,
  `original_name` LONGTEXT NOT NULL,
  `db_file_name` LONGTEXT NOT NULL,
  `storage_object_id` VARCHAR(255),
  `mime_type` LONGTEXT NOT NULL,
  `size_bytes` BIGINT NOT NULL,
  `checksum_sha256` LONGTEXT,
  `created_by` VARCHAR(255) NOT NULL,
  `created_at` VARCHAR(255) NOT NULL,
  `__uq_idx_aigc_file_versions_file_version` BINARY(32) GENERATED ALWAYS AS (CASE WHEN `file_id` IS NULL OR `version_number` IS NULL THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(`file_id`,`version_number`) AS CHAR CHARACTER SET utf8mb4),256)) END) STORED,
  UNIQUE KEY `idx_aigc_file_versions_file_version` (`__uq_idx_aigc_file_versions_file_version`),
  KEY `idx_aigc_file_versions_checksum` (`checksum_sha256`(191),`size_bytes`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `aigc_files` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `language_project_id` VARCHAR(255) NOT NULL,
  `folder_id` VARCHAR(255) NOT NULL,
  `display_name` LONGTEXT NOT NULL,
  `file_kind` LONGTEXT NOT NULL,
  `current_version_id` VARCHAR(255),
  `status` LONGTEXT NOT NULL,
  `source` LONGTEXT NOT NULL DEFAULT ('project'),
  `created_by` VARCHAR(255) NOT NULL,
  `created_at` VARCHAR(255) NOT NULL,
  `updated_at` VARCHAR(255) NOT NULL,
  `deleted_at` VARCHAR(255)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `aigc_folders` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `language_project_id` VARCHAR(255) NOT NULL,
  `client_id` VARCHAR(255),
  `project_id` VARCHAR(255),
  `video_id` VARCHAR(255),
  `node_type` LONGTEXT NOT NULL DEFAULT ('legacy'),
  `parent_folder_id` VARCHAR(255),
  `folder_code` LONGTEXT,
  `name` LONGTEXT NOT NULL,
  `name_zh` LONGTEXT,
  `name_en` LONGTEXT,
  `path_cache` LONGTEXT NOT NULL,
  `depth` BIGINT NOT NULL DEFAULT (0),
  `is_system` BIGINT NOT NULL DEFAULT (false),
  `sort_order` BIGINT NOT NULL DEFAULT (0),
  `created_by` VARCHAR(255) NOT NULL,
  `created_at` VARCHAR(255) NOT NULL,
  `updated_at` VARCHAR(255) NOT NULL,
  `deleted_at` VARCHAR(255),
  `__uq_live_sibling` BINARY(32) GENERATED ALWAYS AS (CASE WHEN deleted_at IS NOT NULL THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(language_project_id,COALESCE(parent_folder_id,''),name) AS CHAR CHARACTER SET utf8mb4),256)) END) STORED,
  UNIQUE KEY `idx_aigc_folders_sibling_name` (`__uq_live_sibling`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `aigc_storage_objects` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `provider` LONGTEXT NOT NULL,
  `bucket_name` LONGTEXT NOT NULL,
  `region_name` LONGTEXT NOT NULL,
  `endpoint_url` LONGTEXT,
  `object_key` LONGTEXT NOT NULL,
  `etag` LONGTEXT,
  `storage_class` LONGTEXT NOT NULL DEFAULT ('STANDARD'),
  `created_at` VARCHAR(255) NOT NULL,
  `__uq_aigc_storage_objects_object_key_unique` BINARY(32) GENERATED ALWAYS AS (CASE WHEN `object_key` IS NULL THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(`object_key`) AS CHAR CHARACTER SET utf8mb4),256)) END) STORED,
  UNIQUE KEY `aigc_storage_objects_object_key_unique` (`__uq_aigc_storage_objects_object_key_unique`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `asset_collection_files` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `collection_id` VARCHAR(255) NOT NULL,
  `file_id` VARCHAR(255) NOT NULL,
  `relation_type` LONGTEXT NOT NULL,
  `category` LONGTEXT NOT NULL,
  `created_by` VARCHAR(255) NOT NULL,
  `created_at` VARCHAR(255) NOT NULL,
  `__uq_idx_asset_collection_files_collection_file` BINARY(32) GENERATED ALWAYS AS (CASE WHEN `collection_id` IS NULL OR `file_id` IS NULL THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(`collection_id`,`file_id`) AS CHAR CHARACTER SET utf8mb4),256)) END) STORED,
  UNIQUE KEY `idx_asset_collection_files_collection_file` (`__uq_idx_asset_collection_files_collection_file`),
  KEY `idx_asset_collection_files_file` (`file_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `asset_collections` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `collection_code` LONGTEXT NOT NULL,
  `title` LONGTEXT NOT NULL,
  `description` LONGTEXT NOT NULL DEFAULT (''),
  `tags_json` LONGTEXT NOT NULL DEFAULT ('[]'),
  `root_folder_id` VARCHAR(255) NOT NULL,
  `final_folder_id` VARCHAR(255) NOT NULL,
  `source_folder_id` VARCHAR(255) NOT NULL,
  `cover_file_id` VARCHAR(255),
  `final_file_id` VARCHAR(255),
  `status` LONGTEXT NOT NULL DEFAULT ('active'),
  `created_by` VARCHAR(255) NOT NULL,
  `created_at` VARCHAR(255) NOT NULL,
  `updated_at` VARCHAR(255) NOT NULL,
  `revision` BIGINT NOT NULL DEFAULT (1),
  `__uq_asset_collections_collection_code_unique` BINARY(32) GENERATED ALWAYS AS (CASE WHEN `collection_code` IS NULL THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(`collection_code`) AS CHAR CHARACTER SET utf8mb4),256)) END) STORED,
  UNIQUE KEY `asset_collections_collection_code_unique` (`__uq_asset_collections_collection_code_unique`),
  `__uq_idx_asset_collections_title` BINARY(32) GENERATED ALWAYS AS (CASE WHEN `title` IS NULL THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(`title`) AS CHAR CHARACTER SET utf8mb4),256)) END) STORED,
  UNIQUE KEY `idx_asset_collections_title` (`__uq_idx_asset_collections_title`),
  KEY `idx_asset_collections_updated` (`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `asset_lineage` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `output_file_id` VARCHAR(255) NOT NULL,
  `output_version_id` VARCHAR(255) NOT NULL,
  `source_asset_id` VARCHAR(255) NOT NULL,
  `source_version_id` VARCHAR(255),
  `created_by` VARCHAR(255) NOT NULL,
  `created_at` VARCHAR(255) NOT NULL,
  `__uq_idx_asset_lineage_output_source` BINARY(32) GENERATED ALWAYS AS (CASE WHEN `output_version_id` IS NULL OR `source_asset_id` IS NULL THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(`output_version_id`,`source_asset_id`) AS CHAR CHARACTER SET utf8mb4),256)) END) STORED,
  UNIQUE KEY `idx_asset_lineage_output_source` (`__uq_idx_asset_lineage_output_source`),
  KEY `idx_asset_lineage_source` (`source_asset_id`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `audit_logs` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `action` LONGTEXT NOT NULL,
  `actor_email` VARCHAR(254) NOT NULL,
  `subject` LONGTEXT NOT NULL,
  `details` LONGTEXT NOT NULL,
  `created_at` VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `business_name_translations` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `entity_kind` LONGTEXT NOT NULL,
  `entity_id` VARCHAR(255) NOT NULL,
  `source_name` LONGTEXT NOT NULL,
  `base_zh` LONGTEXT NOT NULL,
  `base_en` LONGTEXT NOT NULL,
  `name_zh` LONGTEXT NOT NULL,
  `name_en` LONGTEXT NOT NULL,
  `status` LONGTEXT NOT NULL,
  `updated_by` VARCHAR(255) NOT NULL,
  `updated_at` VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `checkpoint_environment_snapshots` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `checkpoint_id` VARCHAR(255) NOT NULL,
  `app_name` LONGTEXT NOT NULL DEFAULT (''),
  `app_version` LONGTEXT NOT NULL DEFAULT (''),
  `plugins_json` LONGTEXT NOT NULL DEFAULT ('[]'),
  `fonts_json` LONGTEXT NOT NULL DEFAULT ('[]'),
  `os_name` LONGTEXT NOT NULL DEFAULT (''),
  `notes` LONGTEXT NOT NULL DEFAULT (''),
  `created_at` VARCHAR(255) NOT NULL,
  `__uq_idx_checkpoint_environment_unique` BINARY(32) GENERATED ALWAYS AS (CASE WHEN `checkpoint_id` IS NULL THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(`checkpoint_id`) AS CHAR CHARACTER SET utf8mb4),256)) END) STORED,
  UNIQUE KEY `idx_checkpoint_environment_unique` (`__uq_idx_checkpoint_environment_unique`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `client_profiles` (
  `client_id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `legal_name` LONGTEXT NOT NULL,
  `region` LONGTEXT NOT NULL,
  `industry` LONGTEXT NOT NULL,
  `contact_name` LONGTEXT NOT NULL,
  `contact_email` VARCHAR(254) NOT NULL,
  `contact_phone` LONGTEXT NOT NULL,
  `notes` LONGTEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `clients` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `client_code` LONGTEXT,
  `name` LONGTEXT NOT NULL,
  `owner_email` VARCHAR(254) NOT NULL,
  `deleted_at` VARCHAR(255),
  `deleted_by` LONGTEXT,
  `deletion_batch_id` VARCHAR(255),
  `root_folder_id` VARCHAR(255),
  `contact_count` BIGINT NOT NULL DEFAULT (1),
  `status` LONGTEXT NOT NULL,
  `last_contact_at` VARCHAR(255),
  `updated_at` VARCHAR(255) NOT NULL,
  `revision` BIGINT NOT NULL DEFAULT (1),
  `__uq_idx_clients_client_code` BINARY(32) GENERATED ALWAYS AS (CASE WHEN `client_code` IS NULL THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(`client_code`) AS CHAR CHARACTER SET utf8mb4),256)) END) STORED,
  UNIQUE KEY `idx_clients_client_code` (`__uq_idx_clients_client_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `deliveries` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `project_id` VARCHAR(255) NOT NULL,
  `language_project_id` VARCHAR(255),
  `file_id` VARCHAR(255),
  `owner_email` VARCHAR(254) NOT NULL,
  `status` LONGTEXT NOT NULL,
  `notes` LONGTEXT,
  `delivered_at` VARCHAR(255),
  `created_at` VARCHAR(255) NOT NULL,
  KEY `idx_deliveries_language_created` (`language_project_id`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `editor_workspaces` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `account_email` VARCHAR(254) NOT NULL,
  `display_name` LONGTEXT NOT NULL,
  `status` LONGTEXT NOT NULL DEFAULT ('active'),
  `created_at` VARCHAR(255) NOT NULL,
  `updated_at` VARCHAR(255) NOT NULL,
  `__uq_idx_editor_workspaces_account` BINARY(32) GENERATED ALWAYS AS (CASE WHEN `account_email` IS NULL THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(`account_email`) AS CHAR CHARACTER SET utf8mb4),256)) END) STORED,
  UNIQUE KEY `idx_editor_workspaces_account` (`__uq_idx_editor_workspaces_account`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `feedback` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `project_id` VARCHAR(255) NOT NULL,
  `language_project_id` VARCHAR(255),
  `file_id` VARCHAR(255),
  `owner_email` VARCHAR(254) NOT NULL,
  `decision` LONGTEXT,
  `summary` LONGTEXT NOT NULL,
  `status` LONGTEXT NOT NULL,
  `created_at` VARCHAR(255) NOT NULL,
  KEY `idx_feedback_language_created` (`language_project_id`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `handover_records` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `language_project_id` VARCHAR(255) NOT NULL,
  `checkpoint_id` VARCHAR(255),
  `from_user_email` VARCHAR(254),
  `to_user_email` VARCHAR(254) NOT NULL,
  `reason` LONGTEXT NOT NULL,
  `handover_type` LONGTEXT NOT NULL DEFAULT ('planned'),
  `status` LONGTEXT NOT NULL DEFAULT ('pending'),
  `completeness_status` LONGTEXT NOT NULL,
  `risk_notes` LONGTEXT NOT NULL DEFAULT (''),
  `attachments_json` LONGTEXT NOT NULL DEFAULT ('[]'),
  `initiated_by` LONGTEXT NOT NULL,
  `accept_notes` LONGTEXT NOT NULL DEFAULT (''),
  `due_at` VARCHAR(255),
  `created_at` VARCHAR(255) NOT NULL,
  `accepted_at` VARCHAR(255),
  KEY `idx_handover_records_task_created` (`language_project_id`,`created_at`),
  KEY `idx_handover_records_assignee_status` (`to_user_email`,`status`(191))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `language_assignment_history` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `language_project_id` VARCHAR(255) NOT NULL,
  `previous_editor_email` VARCHAR(254),
  `new_editor_email` VARCHAR(254),
  `previous_reviewer_email` VARCHAR(254),
  `new_reviewer_email` VARCHAR(254),
  `reason` LONGTEXT NOT NULL DEFAULT (''),
  `changed_by` LONGTEXT NOT NULL,
  `created_at` VARCHAR(255) NOT NULL,
  KEY `idx_language_assignment_history_task` (`language_project_id`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `language_projects` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `project_id` VARCHAR(255) NOT NULL,
  `video_id` VARCHAR(255) NOT NULL DEFAULT (''),
  `project_type_id` VARCHAR(255) NOT NULL,
  `language` LONGTEXT NOT NULL,
  `language_code` LONGTEXT NOT NULL,
  `editor_email` VARCHAR(254),
  `reviewer_email` VARCHAR(254),
  `materials_confirmed_at` VARCHAR(255),
  `materials_confirmed_by` LONGTEXT,
  `production_progress` BIGINT,
  `production_progress_note` LONGTEXT NOT NULL DEFAULT (''),
  `production_progress_at` VARCHAR(255),
  `production_progress_by` LONGTEXT,
  `paused_from_status` LONGTEXT,
  `status` LONGTEXT NOT NULL,
  `requirements` LONGTEXT NOT NULL,
  `material_standard_version` BIGINT NOT NULL DEFAULT (1),
  `due_date` VARCHAR(255) NOT NULL,
  `updated_at` VARCHAR(255) NOT NULL,
  `revision` BIGINT NOT NULL DEFAULT (1),
  `__uq_idx_language_projects_video_language` BINARY(32) GENERATED ALWAYS AS (CASE WHEN `video_id` IS NULL OR `language_code` IS NULL THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(`video_id`,`language_code`) AS CHAR CHARACTER SET utf8mb4),256)) END) STORED,
  UNIQUE KEY `idx_language_projects_video_language` (`__uq_idx_language_projects_video_language`),
  KEY `idx_language_projects_editor` (`editor_email`,`status`(191)),
  KEY `idx_language_projects_reviewer` (`reviewer_email`,`status`(191))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `login_attempts` (
  `email` VARCHAR(254) NOT NULL PRIMARY KEY,
  `attempt_count` BIGINT NOT NULL DEFAULT (0),
  `first_attempt_at` VARCHAR(255) NOT NULL,
  `locked_until` LONGTEXT,
  `updated_at` VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `material_standards` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `project_type_id` VARCHAR(255) NOT NULL,
  `client_id` VARCHAR(255),
  `scope_type` LONGTEXT NOT NULL DEFAULT ('language'),
  `project_id` VARCHAR(255),
  `language_project_id` VARCHAR(255),
  `logical_file_id` VARCHAR(255),
  `file_version_id` VARCHAR(255),
  `version` BIGINT NOT NULL,
  `status` LONGTEXT NOT NULL,
  `content_zh` LONGTEXT NOT NULL,
  `content_en` LONGTEXT NOT NULL,
  `change_notes` LONGTEXT NOT NULL DEFAULT (''),
  `is_current` BIGINT NOT NULL DEFAULT (false),
  `author_email` VARCHAR(254) NOT NULL,
  `reviewer_email` VARCHAR(254),
  `created_at` VARCHAR(255),
  `updated_at` VARCHAR(255) NOT NULL,
  `revision` BIGINT NOT NULL DEFAULT (1),
  KEY `idx_material_standards_language_version` (`language_project_id`,`version`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `mutation_guards` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `satisfied` BIGINT NOT NULL,
  CONSTRAINT `mutation_guard_current` CHECK (`mutation_guards`.`satisfied` = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `notifications` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `recipient_email` VARCHAR(254) NOT NULL,
  `recipient_account_id` VARCHAR(255) NOT NULL DEFAULT (''),
  `type` LONGTEXT NOT NULL,
  `actor_email` VARCHAR(254),
  `actor_name` LONGTEXT,
  `actor_role` LONGTEXT,
  `event_action` LONGTEXT,
  `title_zh` LONGTEXT NOT NULL,
  `title_en` LONGTEXT NOT NULL,
  `body_zh` LONGTEXT NOT NULL,
  `body_en` LONGTEXT NOT NULL,
  `target_type` LONGTEXT,
  `target_id` VARCHAR(255),
  `is_read` BIGINT NOT NULL DEFAULT (false),
  `read_at` VARCHAR(255),
  `business_status` LONGTEXT NOT NULL DEFAULT ('pending'),
  `archived_at` VARCHAR(255),
  `created_at` VARCHAR(255) NOT NULL,
  `revision` BIGINT NOT NULL DEFAULT (1),
  KEY `idx_notifications_account_created` (`recipient_account_id`,`created_at`),
  KEY `idx_notifications_account_read` (`recipient_account_id`,`is_read`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `production_checkpoint_drafts` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `language_project_id` VARCHAR(255) NOT NULL,
  `editor_email` VARCHAR(254) NOT NULL,
  `mode` LONGTEXT NOT NULL DEFAULT ('new'),
  `source_checkpoint_id` VARCHAR(255),
  `project_file_version_id` VARCHAR(255),
  `preview_file_version_id` VARCHAR(255),
  `material_version_ids_json` LONGTEXT NOT NULL DEFAULT ('[]'),
  `source_asset_ids_json` LONGTEXT NOT NULL DEFAULT ('[]'),
  `completed_work` LONGTEXT NOT NULL DEFAULT (''),
  `pending_work` LONGTEXT NOT NULL DEFAULT (''),
  `next_steps` LONGTEXT NOT NULL DEFAULT (''),
  `notes` LONGTEXT NOT NULL DEFAULT (''),
  `app_name` LONGTEXT NOT NULL DEFAULT (''),
  `app_version` LONGTEXT NOT NULL DEFAULT (''),
  `os_name` LONGTEXT NOT NULL DEFAULT (''),
  `created_at` VARCHAR(255) NOT NULL,
  `updated_at` VARCHAR(255) NOT NULL,
  `__uq_idx_checkpoint_drafts_task_editor` BINARY(32) GENERATED ALWAYS AS (CASE WHEN `language_project_id` IS NULL OR `editor_email` IS NULL THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(`language_project_id`,`editor_email`) AS CHAR CHARACTER SET utf8mb4),256)) END) STORED,
  UNIQUE KEY `idx_checkpoint_drafts_task_editor` (`__uq_idx_checkpoint_drafts_task_editor`),
  KEY `idx_checkpoint_drafts_editor_updated` (`editor_email`,`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `production_checkpoint_files` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `checkpoint_id` VARCHAR(255) NOT NULL,
  `file_version_id` VARCHAR(255) NOT NULL,
  `file_role` LONGTEXT NOT NULL,
  `is_required` BIGINT NOT NULL DEFAULT (false),
  `checksum_sha256` LONGTEXT,
  `created_at` VARCHAR(255) NOT NULL,
  `__uq_idx_checkpoint_files_unique` BINARY(32) GENERATED ALWAYS AS (CASE WHEN `checkpoint_id` IS NULL OR `file_version_id` IS NULL OR `file_role` IS NULL THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(`checkpoint_id`,`file_version_id`,`file_role`) AS CHAR CHARACTER SET utf8mb4),256)) END) STORED,
  UNIQUE KEY `idx_checkpoint_files_unique` (`__uq_idx_checkpoint_files_unique`),
  KEY `idx_checkpoint_files_checkpoint` (`checkpoint_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `production_checkpoints` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `language_project_id` VARCHAR(255) NOT NULL,
  `version_number` BIGINT NOT NULL,
  `checkpoint_number` BIGINT NOT NULL DEFAULT (1),
  `attachment_schema` BIGINT NOT NULL DEFAULT (1),
  `production_progress` BIGINT,
  `revision_number` BIGINT NOT NULL DEFAULT (1),
  `parent_checkpoint_id` VARCHAR(255),
  `supersedes_checkpoint_id` VARCHAR(255),
  `editor_email` VARCHAR(254) NOT NULL,
  `status` LONGTEXT NOT NULL DEFAULT ('ready'),
  `completeness_status` LONGTEXT NOT NULL DEFAULT ('complete'),
  `completeness_json` LONGTEXT NOT NULL DEFAULT ('{}'),
  `completed_work` LONGTEXT NOT NULL DEFAULT (''),
  `pending_work` LONGTEXT NOT NULL DEFAULT (''),
  `next_steps` LONGTEXT NOT NULL DEFAULT (''),
  `notes` LONGTEXT NOT NULL DEFAULT (''),
  `project_file_version_id` VARCHAR(255) NOT NULL,
  `preview_file_version_id` VARCHAR(255) NOT NULL,
  `manifest_file_version_id` VARCHAR(255),
  `file_count` BIGINT NOT NULL DEFAULT (0),
  `created_at` VARCHAR(255) NOT NULL,
  `updated_at` VARCHAR(255) NOT NULL,
  `frozen_at` VARCHAR(255),
  `editable_until` LONGTEXT,
  `invalidated_at` VARCHAR(255),
  `invalidated_by` LONGTEXT,
  `invalidation_reason` LONGTEXT NOT NULL DEFAULT (''),
  `__uq_idx_production_checkpoints_task_version` BINARY(32) GENERATED ALWAYS AS (CASE WHEN `language_project_id` IS NULL OR `version_number` IS NULL THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(`language_project_id`,`version_number`) AS CHAR CHARACTER SET utf8mb4),256)) END) STORED,
  UNIQUE KEY `idx_production_checkpoints_task_version` (`__uq_idx_production_checkpoints_task_version`),
  `__uq_idx_production_checkpoints_series_revision` BINARY(32) GENERATED ALWAYS AS (CASE WHEN `language_project_id` IS NULL OR `checkpoint_number` IS NULL OR `revision_number` IS NULL THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(`language_project_id`,`checkpoint_number`,`revision_number`) AS CHAR CHARACTER SET utf8mb4),256)) END) STORED,
  UNIQUE KEY `idx_production_checkpoints_series_revision` (`__uq_idx_production_checkpoints_series_revision`),
  KEY `idx_production_checkpoints_task_created` (`language_project_id`,`created_at`),
  KEY `idx_production_checkpoints_editor_status` (`editor_email`,`status`(191))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `production_final_submission_files` (
  `submission_id` VARCHAR(255) NOT NULL,
  `file_version_id` VARCHAR(255) NOT NULL,
  `category` LONGTEXT NOT NULL,
  `__uq_idx_production_final_member` BINARY(32) GENERATED ALWAYS AS (CASE WHEN `submission_id` IS NULL OR `file_version_id` IS NULL THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(`submission_id`,`file_version_id`) AS CHAR CHARACTER SET utf8mb4),256)) END) STORED,
  UNIQUE KEY `idx_production_final_member` (`__uq_idx_production_final_member`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `production_final_submissions` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `language_project_id` VARCHAR(255) NOT NULL,
  `final_version_id` VARCHAR(255) NOT NULL,
  `submitted_by` LONGTEXT NOT NULL,
  `submitted_at` VARCHAR(255) NOT NULL,
  `notes` LONGTEXT NOT NULL DEFAULT (''),
  `daily_report_revision_id` VARCHAR(255),
  KEY `idx_production_final_task` (`language_project_id`,`submitted_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `production_flow_events` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `language_project_id` VARCHAR(255) NOT NULL,
  `stage` LONGTEXT NOT NULL,
  `action` LONGTEXT NOT NULL,
  `task_revision` BIGINT NOT NULL,
  `actor_email` VARCHAR(254) NOT NULL,
  `created_at` VARCHAR(255) NOT NULL,
  `__uq_idx_flow_task_revision` BINARY(32) GENERATED ALWAYS AS (CASE WHEN `language_project_id` IS NULL OR `task_revision` IS NULL THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(`language_project_id`,`task_revision`) AS CHAR CHARACTER SET utf8mb4),256)) END) STORED,
  UNIQUE KEY `idx_flow_task_revision` (`__uq_idx_flow_task_revision`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `production_flow_files` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `event_id` VARCHAR(255) NOT NULL,
  `file_version_id` VARCHAR(255) NOT NULL,
  KEY `idx_flow_files_event` (`event_id`),
  KEY `idx_flow_files_version` (`file_version_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `production_staged_files` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `actor_email` VARCHAR(254) NOT NULL,
  `language_project_id` VARCHAR(255) NOT NULL,
  `purpose` LONGTEXT NOT NULL,
  `category` LONGTEXT NOT NULL,
  `original_name` LONGTEXT NOT NULL,
  `mime_type` LONGTEXT NOT NULL,
  `file_kind` LONGTEXT NOT NULL,
  `size_bytes` BIGINT NOT NULL,
  `checksum_sha256` LONGTEXT NOT NULL,
  `object_key` LONGTEXT NOT NULL,
  `state` LONGTEXT NOT NULL DEFAULT ('uploading'),
  `committed_version_id` VARCHAR(255),
  `committed_submission_id` VARCHAR(255),
  `created_at` VARCHAR(255) NOT NULL,
  `updated_at` VARCHAR(255) NOT NULL,
  `expires_at` VARCHAR(255) NOT NULL,
  KEY `idx_production_staged_owner_task` (`actor_email`,`language_project_id`,`state`(191)),
  KEY `idx_production_staged_expiry` (`state`(191),`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `production_submission_receipts` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `actor_email` VARCHAR(254) NOT NULL,
  `payload_hash` VARCHAR(255) NOT NULL,
  `response_json` LONGTEXT NOT NULL,
  `created_at` VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `project_files` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `project_id` VARCHAR(255) NOT NULL,
  `language_project_id` VARCHAR(255) NOT NULL,
  `directory` LONGTEXT NOT NULL,
  `original_name` LONGTEXT NOT NULL,
  `storage_name` LONGTEXT NOT NULL,
  `object_key` LONGTEXT,
  `mime_type` LONGTEXT NOT NULL,
  `size_bytes` BIGINT NOT NULL,
  `version` BIGINT NOT NULL DEFAULT (1),
  `uploader_email` VARCHAR(254) NOT NULL,
  `status` LONGTEXT NOT NULL,
  `source` LONGTEXT NOT NULL DEFAULT ('project'),
  `created_at` VARCHAR(255) NOT NULL,
  `deleted_at` VARCHAR(255)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `project_request_analyses` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `request_id` VARCHAR(255) NOT NULL,
  `request_revision` BIGINT NOT NULL,
  `status` LONGTEXT NOT NULL DEFAULT ('processing'),
  `provider` LONGTEXT NOT NULL DEFAULT ('zhipu'),
  `model` LONGTEXT NOT NULL,
  `source_document_ids_json` LONGTEXT NOT NULL DEFAULT ('[]'),
  `summary_zh` LONGTEXT NOT NULL DEFAULT (''),
  `summary_en` LONGTEXT NOT NULL DEFAULT (''),
  `structured_json` LONGTEXT NOT NULL DEFAULT ('{}'),
  `error_message` LONGTEXT NOT NULL DEFAULT (''),
  `progress_stage` LONGTEXT NOT NULL DEFAULT ('idle'),
  `progress_percent` BIGINT NOT NULL DEFAULT (0),
  `created_by` VARCHAR(255) NOT NULL,
  `created_at` VARCHAR(255) NOT NULL,
  `updated_at` VARCHAR(255) NOT NULL,
  `confirmed_by` LONGTEXT,
  `confirmed_at` VARCHAR(255),
  `__uq_idx_project_request_analyses_request_revision` BINARY(32) GENERATED ALWAYS AS (CASE WHEN `request_id` IS NULL OR `request_revision` IS NULL THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(`request_id`,`request_revision`) AS CHAR CHARACTER SET utf8mb4),256)) END) STORED,
  UNIQUE KEY `idx_project_request_analyses_request_revision` (`__uq_idx_project_request_analyses_request_revision`),
  KEY `idx_project_request_analyses_status_updated` (`status`(191),`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `project_request_documents` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `request_id` VARCHAR(255) NOT NULL,
  `request_revision` BIGINT NOT NULL,
  `original_name` LONGTEXT NOT NULL,
  `mime_type` LONGTEXT NOT NULL,
  `size_bytes` BIGINT NOT NULL,
  `checksum_sha256` LONGTEXT NOT NULL,
  `object_key` LONGTEXT NOT NULL,
  `uploaded_by` LONGTEXT NOT NULL,
  `created_at` VARCHAR(255) NOT NULL,
  `deleted_at` VARCHAR(255),
  KEY `idx_project_request_documents_request_revision` (`request_id`,`request_revision`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `project_request_revisions` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `request_id` VARCHAR(255) NOT NULL,
  `revision_number` BIGINT NOT NULL,
  `title` LONGTEXT NOT NULL,
  `title_zh` LONGTEXT,
  `title_en` LONGTEXT,
  `language_codes` LONGTEXT NOT NULL,
  `videos_json` LONGTEXT NOT NULL DEFAULT ('[]'),
  `requirements` LONGTEXT NOT NULL,
  `due_date` VARCHAR(255) NOT NULL,
  `submitted_by` LONGTEXT NOT NULL,
  `change_notes` LONGTEXT NOT NULL DEFAULT (''),
  `created_at` VARCHAR(255) NOT NULL,
  `__uq_idx_project_request_revisions_request_number` BINARY(32) GENERATED ALWAYS AS (CASE WHEN `request_id` IS NULL OR `revision_number` IS NULL THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(`request_id`,`revision_number`) AS CHAR CHARACTER SET utf8mb4),256)) END) STORED,
  UNIQUE KEY `idx_project_request_revisions_request_number` (`__uq_idx_project_request_revisions_request_number`),
  KEY `idx_project_request_revisions_request_created` (`request_id`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `project_requests` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `client_id` VARCHAR(255) NOT NULL,
  `sales_email` VARCHAR(254) NOT NULL,
  `deleted_at` VARCHAR(255),
  `deleted_by` LONGTEXT,
  `deletion_batch_id` VARCHAR(255),
  `recycle_revision` BIGINT NOT NULL DEFAULT (1),
  `title` LONGTEXT NOT NULL,
  `title_zh` LONGTEXT,
  `title_en` LONGTEXT,
  `language_codes` LONGTEXT NOT NULL,
  `videos_json` LONGTEXT NOT NULL DEFAULT ('[]'),
  `requirements` LONGTEXT NOT NULL,
  `due_date` VARCHAR(255) NOT NULL,
  `status` LONGTEXT NOT NULL DEFAULT ('submitted'),
  `creation_mode` LONGTEXT NOT NULL DEFAULT ('legacy'),
  `pm_email` VARCHAR(254),
  `project_id` VARCHAR(255),
  `planning_json` LONGTEXT NOT NULL DEFAULT ('{}'),
  `plan_version` BIGINT NOT NULL DEFAULT (0),
  `decision_notes` LONGTEXT,
  `created_at` VARCHAR(255) NOT NULL,
  `updated_at` VARCHAR(255) NOT NULL,
  `revision` BIGINT NOT NULL DEFAULT (1),
  KEY `idx_project_requests_sales_status` (`sales_email`,`status`(191)),
  KEY `idx_project_requests_status_created` (`status`(191),`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `project_types` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `name_zh` LONGTEXT NOT NULL,
  `name_en` LONGTEXT NOT NULL,
  `description_zh` LONGTEXT NOT NULL,
  `description_en` LONGTEXT NOT NULL,
  `status` LONGTEXT NOT NULL,
  `owner_email` VARCHAR(254) NOT NULL,
  `current_version` BIGINT NOT NULL DEFAULT (1),
  `updated_at` VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `project_videos` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `project_id` VARCHAR(255) NOT NULL,
  `video_code` LONGTEXT NOT NULL,
  `root_folder_id` VARCHAR(255),
  `name` LONGTEXT NOT NULL,
  `name_zh` LONGTEXT,
  `name_en` LONGTEXT,
  `brief` LONGTEXT NOT NULL DEFAULT (''),
  `duration_seconds` BIGINT,
  `aspect_ratio` LONGTEXT NOT NULL DEFAULT ('16:9'),
  `priority` LONGTEXT NOT NULL DEFAULT ('standard'),
  `due_date` VARCHAR(255) NOT NULL,
  `sort_order` BIGINT NOT NULL DEFAULT (0),
  `updated_at` VARCHAR(255) NOT NULL,
  `revision` BIGINT NOT NULL DEFAULT (1),
  KEY `idx_project_videos_project_sort` (`project_id`,`sort_order`),
  `__uq_idx_project_videos_project_code` BINARY(32) GENERATED ALWAYS AS (CASE WHEN `project_id` IS NULL OR `video_code` IS NULL THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(`project_id`,`video_code`) AS CHAR CHARACTER SET utf8mb4),256)) END) STORED,
  UNIQUE KEY `idx_project_videos_project_code` (`__uq_idx_project_videos_project_code`),
  `__uq_idx_project_videos_project_name_zh` BINARY(32) GENERATED ALWAYS AS (CASE WHEN `project_id` IS NULL OR `name_zh` IS NULL THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(`project_id`,`name_zh`) AS CHAR CHARACTER SET utf8mb4),256)) END) STORED,
  UNIQUE KEY `idx_project_videos_project_name_zh` (`__uq_idx_project_videos_project_name_zh`),
  `__uq_idx_project_videos_project_name_en` BINARY(32) GENERATED ALWAYS AS (CASE WHEN `project_id` IS NULL OR `name_en` IS NULL THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(`project_id`,`name_en`) AS CHAR CHARACTER SET utf8mb4),256)) END) STORED,
  UNIQUE KEY `idx_project_videos_project_name_en` (`__uq_idx_project_videos_project_name_en`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `projects` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `project_code` LONGTEXT,
  `client_id` VARCHAR(255) NOT NULL,
  `root_folder_id` VARCHAR(255),
  `name` LONGTEXT NOT NULL,
  `name_zh` LONGTEXT,
  `name_en` LONGTEXT,
  `sales_email` VARCHAR(254) NOT NULL,
  `project_owner_email` VARCHAR(254) NOT NULL,
  `editor_email` VARCHAR(254),
  `reviewer_email` VARCHAR(254),
  `status` LONGTEXT NOT NULL,
  `priority` LONGTEXT NOT NULL DEFAULT ('standard'),
  `specification` LONGTEXT NOT NULL,
  `due_date` VARCHAR(255) NOT NULL,
  `updated_at` VARCHAR(255) NOT NULL,
  `revision` BIGINT NOT NULL DEFAULT (1),
  `__uq_idx_projects_project_code` BINARY(32) GENERATED ALWAYS AS (CASE WHEN `project_code` IS NULL THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(`project_code`) AS CHAR CHARACTER SET utf8mb4),256)) END) STORED,
  UNIQUE KEY `idx_projects_project_code` (`__uq_idx_projects_project_code`),
  `__uq_idx_projects_client_name_zh` BINARY(32) GENERATED ALWAYS AS (CASE WHEN `client_id` IS NULL OR `name_zh` IS NULL THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(`client_id`,`name_zh`) AS CHAR CHARACTER SET utf8mb4),256)) END) STORED,
  UNIQUE KEY `idx_projects_client_name_zh` (`__uq_idx_projects_client_name_zh`),
  `__uq_idx_projects_client_name_en` BINARY(32) GENERATED ALWAYS AS (CASE WHEN `client_id` IS NULL OR `name_en` IS NULL THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(`client_id`,`name_en`) AS CHAR CHARACTER SET utf8mb4),256)) END) STORED,
  UNIQUE KEY `idx_projects_client_name_en` (`__uq_idx_projects_client_name_en`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `publish_records` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `project_id` VARCHAR(255) NOT NULL,
  `file_id` VARCHAR(255) NOT NULL,
  `title_zh` LONGTEXT NOT NULL,
  `title_en` LONGTEXT NOT NULL,
  `region` LONGTEXT NOT NULL,
  `client_name` LONGTEXT NOT NULL,
  `video_type` LONGTEXT NOT NULL,
  `offering` LONGTEXT NOT NULL,
  `status` LONGTEXT NOT NULL,
  `published_at` VARCHAR(255),
  `updated_at` VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `quality_rounds` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `project_id` VARCHAR(255) NOT NULL,
  `language_project_id` VARCHAR(255) NOT NULL,
  `file_id` VARCHAR(255) NOT NULL,
  `round_number` BIGINT NOT NULL,
  `reviewer_email` VARCHAR(254) NOT NULL,
  `result` LONGTEXT NOT NULL,
  `comments` LONGTEXT NOT NULL,
  `checklist_json` LONGTEXT NOT NULL DEFAULT ('{}'),
  `issues_json` LONGTEXT NOT NULL DEFAULT ('[]'),
  `report_file_id` VARCHAR(255),
  `report_revision` BIGINT NOT NULL DEFAULT (1),
  `created_at` VARCHAR(255) NOT NULL,
  `__uq_idx_quality_rounds_file_unique` BINARY(32) GENERATED ALWAYS AS (CASE WHEN `file_id` IS NULL THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(`file_id`) AS CHAR CHARACTER SET utf8mb4),256)) END) STORED,
  UNIQUE KEY `idx_quality_rounds_file_unique` (`__uq_idx_quality_rounds_file_unique`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `reviews` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `version_id` VARCHAR(255) NOT NULL,
  `reviewer_email` VARCHAR(254) NOT NULL,
  `result` LONGTEXT NOT NULL,
  `comments` LONGTEXT NOT NULL,
  `created_at` VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `security_rate_limits` (
  `key` VARCHAR(255) NOT NULL PRIMARY KEY,
  `count` BIGINT NOT NULL,
  `expires_at` BIGINT NOT NULL,
  KEY `idx_security_rate_limits_expiry` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `settings` (
  `key` VARCHAR(255) NOT NULL PRIMARY KEY,
  `value` LONGTEXT NOT NULL,
  `updated_at` VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `share_access_sessions` (
  `token_hash` VARCHAR(255) NOT NULL PRIMARY KEY,
  `share_id` VARCHAR(255) NOT NULL,
  `expires_at` VARCHAR(255) NOT NULL,
  `created_at` VARCHAR(255) NOT NULL,
  KEY `idx_share_access_sessions_share` (`share_id`,`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `share_links` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `project_id` VARCHAR(255) NOT NULL,
  `file_id` VARCHAR(255) NOT NULL,
  `kind` LONGTEXT NOT NULL,
  `token` LONGTEXT NOT NULL,
  `password_hash` VARCHAR(255),
  `enabled` BIGINT NOT NULL DEFAULT (true),
  `expires_at` VARCHAR(255) NOT NULL,
  `creator_email` VARCHAR(254) NOT NULL,
  `access_count` BIGINT NOT NULL DEFAULT (0),
  `created_at` VARCHAR(255) NOT NULL,
  `__uq_share_links_token_unique` BINARY(32) GENERATED ALWAYS AS (CASE WHEN `token` IS NULL THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(`token`) AS CHAR CHARACTER SET utf8mb4),256)) END) STORED,
  UNIQUE KEY `share_links_token_unique` (`__uq_share_links_token_unique`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `task_material_links` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `language_project_id` VARCHAR(255) NOT NULL,
  `checkpoint_id` VARCHAR(255) NOT NULL,
  `material_file_id` VARCHAR(255) NOT NULL,
  `material_version_id` VARCHAR(255) NOT NULL,
  `source_type` LONGTEXT NOT NULL DEFAULT ('project'),
  `created_by` VARCHAR(255) NOT NULL,
  `created_at` VARCHAR(255) NOT NULL,
  `__uq_idx_task_material_links_unique` BINARY(32) GENERATED ALWAYS AS (CASE WHEN `checkpoint_id` IS NULL OR `material_version_id` IS NULL THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(`checkpoint_id`,`material_version_id`) AS CHAR CHARACTER SET utf8mb4),256)) END) STORED,
  UNIQUE KEY `idx_task_material_links_unique` (`__uq_idx_task_material_links_unique`),
  KEY `idx_task_material_links_task` (`language_project_id`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `upload_sessions` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `account_id` VARCHAR(255) NOT NULL,
  `language_project_id` VARCHAR(255) NOT NULL,
  `folder_id` VARCHAR(255) NOT NULL,
  `logical_file_id` VARCHAR(255),
  `original_name` LONGTEXT NOT NULL,
  `size_bytes` BIGINT NOT NULL,
  `fingerprint` LONGTEXT NOT NULL,
  `uploaded_bytes` BIGINT NOT NULL DEFAULT (0),
  `status` LONGTEXT NOT NULL DEFAULT ('pending'),
  `created_at` VARCHAR(255) NOT NULL,
  `updated_at` VARCHAR(255) NOT NULL,
  KEY `idx_upload_sessions_account_status` (`account_id`,`status`(191))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `versions` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `project_id` VARCHAR(255) NOT NULL,
  `delivery_name` LONGTEXT NOT NULL,
  `version_number` BIGINT NOT NULL,
  `submitter_email` VARCHAR(254) NOT NULL,
  `status` LONGTEXT NOT NULL,
  `notes` LONGTEXT NOT NULL,
  `file_size_mb` DOUBLE NOT NULL,
  `created_at` VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `workflow_submissions` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `account_email` VARCHAR(254) NOT NULL,
  `payload_hash` VARCHAR(255) NOT NULL,
  `state` LONGTEXT NOT NULL,
  `response_json` LONGTEXT NOT NULL DEFAULT (''),
  `created_at` VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TRIGGER `trg_notifications_recipient_account` BEFORE INSERT ON `notifications` FOR EACH ROW SET NEW.recipient_account_id = CASE WHEN NEW.recipient_account_id = '' THEN COALESCE((SELECT id FROM accounts WHERE lower(email)=lower(NEW.recipient_email) LIMIT 1),'') ELSE NEW.recipient_account_id END;
