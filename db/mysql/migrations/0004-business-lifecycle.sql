-- Additive customer authorship and durable business deletion. No backfill or cleanup.
ALTER TABLE `clients` ADD COLUMN `created_by` VARCHAR(255) NULL, ADD COLUMN `creator_maintenance_active` BIGINT NOT NULL DEFAULT (0);
--> statement-breakpoint
ALTER TABLE `projects` ADD COLUMN `deleted_at` VARCHAR(255) NULL;
--> statement-breakpoint
CREATE TABLE `business_deletion_jobs` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `target_kind` LONGTEXT NOT NULL,
  `target_id` VARCHAR(255) NOT NULL,
  `target_name` LONGTEXT NOT NULL,
  `target_revision` BIGINT NOT NULL,
  `actor_email` VARCHAR(254) NOT NULL,
  `actor_account_id` VARCHAR(255) NOT NULL,
  `actor_revision` BIGINT NOT NULL,
  `preview_hash` VARCHAR(255) NOT NULL,
  `state` LONGTEXT NOT NULL,
  `summary_json` LONGTEXT NOT NULL,
  `last_error` LONGTEXT NOT NULL DEFAULT (''),
  `lease_id` VARCHAR(255),
  `lease_expires_at` VARCHAR(255),
  `created_at` VARCHAR(255) NOT NULL,
  `updated_at` VARCHAR(255) NOT NULL,
  KEY `idx_business_deletion_jobs_actor` (`actor_email`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `business_deletion_locks` (
  `scope_id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `job_id` VARCHAR(255) NOT NULL,
  `created_at` VARCHAR(255) NOT NULL,
  KEY `idx_business_deletion_locks_job` (`job_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `business_deletion_operations` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `operation_id` VARCHAR(255) NOT NULL,
  `scope_id` VARCHAR(255) NOT NULL,
  `actor_email` VARCHAR(254) NOT NULL,
  `created_at` VARCHAR(255) NOT NULL,
  KEY `idx_business_deletion_operations_scope` (`scope_id`),
  KEY `idx_business_deletion_operations_operation` (`operation_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `business_deletion_records` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `job_id` VARCHAR(255) NOT NULL,
  `table_name` LONGTEXT NOT NULL,
  `selector_json` LONGTEXT NOT NULL,
  `position` BIGINT NOT NULL,
  KEY `idx_business_deletion_records_job` (`job_id`,`position`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE `business_deletion_objects` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `job_id` VARCHAR(255) NOT NULL,
  `object_key` LONGTEXT NOT NULL,
  `state` LONGTEXT NOT NULL,
  `last_error` LONGTEXT NOT NULL DEFAULT (''),
  `updated_at` VARCHAR(255) NOT NULL,
  KEY `idx_business_deletion_objects_job` (`job_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TRIGGER `trg_clients_creator_transfer` BEFORE UPDATE ON `clients` FOR EACH ROW BEGIN
 IF NOT (NEW.owner_email <=> OLD.owner_email) THEN SET NEW.creator_maintenance_active = 0; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_projects_deletion_insert` BEFORE INSERT ON `projects` FOR EACH ROW BEGIN
 IF (EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('customer:',NEW.client_id) OR scope_id=CONCAT('project:',NEW.id))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_projects_deletion_update` BEFORE UPDATE ON `projects` FOR EACH ROW BEGIN
 IF (NOT(NEW.client_id <=> OLD.client_id)) AND (EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('customer:',NEW.client_id) OR scope_id=CONCAT('project:',NEW.id))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_project_videos_deletion_insert` BEFORE INSERT ON `project_videos` FOR EACH ROW BEGIN
 IF (EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('project:',NEW.project_id))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_project_videos_deletion_update` BEFORE UPDATE ON `project_videos` FOR EACH ROW BEGIN
 IF (NOT(NEW.project_id <=> OLD.project_id)) AND (EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('project:',NEW.project_id))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_language_projects_deletion_insert` BEFORE INSERT ON `language_projects` FOR EACH ROW BEGIN
 IF (EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('project:',NEW.project_id))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_language_projects_deletion_update` BEFORE UPDATE ON `language_projects` FOR EACH ROW BEGIN
 IF (NOT(NEW.project_id <=> OLD.project_id) OR NOT(NEW.video_id <=> OLD.video_id)) AND (EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('project:',NEW.project_id))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_project_requests_deletion_insert` BEFORE INSERT ON `project_requests` FOR EACH ROW BEGIN
 IF (EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('customer:',NEW.client_id) OR scope_id=CONCAT('project:',NEW.project_id))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_project_requests_deletion_update` BEFORE UPDATE ON `project_requests` FOR EACH ROW BEGIN
 IF (NOT(NEW.client_id <=> OLD.client_id) OR NOT(NEW.project_id <=> OLD.project_id)) AND (EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('customer:',NEW.client_id) OR scope_id=CONCAT('project:',NEW.project_id))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_project_files_deletion_insert` BEFORE INSERT ON `project_files` FOR EACH ROW BEGIN
 IF (EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('object:',SHA2(NEW.object_key,256))) OR EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('project:',NEW.project_id))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_project_files_deletion_update` BEFORE UPDATE ON `project_files` FOR EACH ROW BEGIN
 IF (NOT(NEW.object_key <=> OLD.object_key) OR NOT(NEW.project_id <=> OLD.project_id)) AND (EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('object:',SHA2(NEW.object_key,256))) OR EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('project:',NEW.project_id))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_aigc_storage_objects_deletion_insert` BEFORE INSERT ON `aigc_storage_objects` FOR EACH ROW BEGIN
 IF (EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('object:',SHA2(NEW.object_key,256)))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_aigc_storage_objects_deletion_update` BEFORE UPDATE ON `aigc_storage_objects` FOR EACH ROW BEGIN
 IF (NOT(NEW.object_key <=> OLD.object_key)) AND (EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('object:',SHA2(NEW.object_key,256)))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_aigc_file_previews_deletion_insert` BEFORE INSERT ON `aigc_file_previews` FOR EACH ROW BEGIN
 IF (EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('object:',SHA2(NEW.object_key,256)))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_aigc_file_previews_deletion_update` BEFORE UPDATE ON `aigc_file_previews` FOR EACH ROW BEGIN
 IF (NOT(NEW.object_key <=> OLD.object_key)) AND (EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('object:',SHA2(NEW.object_key,256)))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_production_staged_files_deletion_insert` BEFORE INSERT ON `production_staged_files` FOR EACH ROW BEGIN
 IF (EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('object:',SHA2(NEW.object_key,256))) OR EXISTS(SELECT 1 FROM language_projects p JOIN business_deletion_locks l ON l.scope_id=CONCAT('project:',p.project_id) WHERE p.id=NEW.language_project_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_production_staged_files_deletion_update` BEFORE UPDATE ON `production_staged_files` FOR EACH ROW BEGIN
 IF (NOT(NEW.object_key <=> OLD.object_key) OR NOT(NEW.language_project_id <=> OLD.language_project_id)) AND (EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('object:',SHA2(NEW.object_key,256))) OR EXISTS(SELECT 1 FROM language_projects p JOIN business_deletion_locks l ON l.scope_id=CONCAT('project:',p.project_id) WHERE p.id=NEW.language_project_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_project_request_documents_deletion_insert` BEFORE INSERT ON `project_request_documents` FOR EACH ROW BEGIN
 IF (EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('object:',SHA2(NEW.object_key,256))) OR EXISTS(SELECT 1 FROM project_requests r JOIN business_deletion_locks l ON l.scope_id=CONCAT('customer:',r.client_id) WHERE r.id=NEW.request_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_project_request_documents_deletion_update` BEFORE UPDATE ON `project_request_documents` FOR EACH ROW BEGIN
 IF (NOT(NEW.object_key <=> OLD.object_key) OR NOT(NEW.request_id <=> OLD.request_id)) AND (EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('object:',SHA2(NEW.object_key,256))) OR EXISTS(SELECT 1 FROM project_requests r JOIN business_deletion_locks l ON l.scope_id=CONCAT('customer:',r.client_id) WHERE r.id=NEW.request_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_aigc_file_versions_deletion_insert` BEFORE INSERT ON `aigc_file_versions` FOR EACH ROW BEGIN
 IF (EXISTS(SELECT 1 FROM aigc_storage_objects o JOIN business_deletion_locks l ON l.scope_id=CONCAT('object:',SHA2(o.object_key,256)) WHERE o.id=NEW.storage_object_id) OR EXISTS(SELECT 1 FROM aigc_files f JOIN language_projects p ON p.id=f.language_project_id JOIN business_deletion_locks l ON l.scope_id=CONCAT('project:',p.project_id) WHERE f.id=NEW.file_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_aigc_file_versions_deletion_update` BEFORE UPDATE ON `aigc_file_versions` FOR EACH ROW BEGIN
 IF (NOT(NEW.storage_object_id <=> OLD.storage_object_id) OR NOT(NEW.file_id <=> OLD.file_id)) AND (EXISTS(SELECT 1 FROM aigc_storage_objects o JOIN business_deletion_locks l ON l.scope_id=CONCAT('object:',SHA2(o.object_key,256)) WHERE o.id=NEW.storage_object_id) OR EXISTS(SELECT 1 FROM aigc_files f JOIN language_projects p ON p.id=f.language_project_id JOIN business_deletion_locks l ON l.scope_id=CONCAT('project:',p.project_id) WHERE f.id=NEW.file_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_task_material_links_deletion_reference_insert` BEFORE INSERT ON `task_material_links` FOR EACH ROW BEGIN
 IF EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('version:',NEW.material_version_id) OR scope_id=CONCAT('file:',NEW.material_file_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_task_material_links_deletion_reference_update` BEFORE UPDATE ON `task_material_links` FOR EACH ROW BEGIN
 IF (NOT(NEW.material_version_id <=> OLD.material_version_id) OR NOT(NEW.material_file_id <=> OLD.material_file_id)) AND EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('version:',NEW.material_version_id) OR scope_id=CONCAT('file:',NEW.material_file_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_production_checkpoint_files_deletion_reference_insert` BEFORE INSERT ON `production_checkpoint_files` FOR EACH ROW BEGIN
 IF EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('version:',NEW.file_version_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_production_checkpoint_files_deletion_reference_update` BEFORE UPDATE ON `production_checkpoint_files` FOR EACH ROW BEGIN
 IF (NOT(NEW.file_version_id <=> OLD.file_version_id)) AND EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('version:',NEW.file_version_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_production_final_submission_files_deletion_reference_insert` BEFORE INSERT ON `production_final_submission_files` FOR EACH ROW BEGIN
 IF EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('version:',NEW.file_version_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_production_final_submission_files_deletion_reference_update` BEFORE UPDATE ON `production_final_submission_files` FOR EACH ROW BEGIN
 IF (NOT(NEW.file_version_id <=> OLD.file_version_id)) AND EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('version:',NEW.file_version_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_production_flow_files_deletion_reference_insert` BEFORE INSERT ON `production_flow_files` FOR EACH ROW BEGIN
 IF EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('version:',NEW.file_version_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_production_flow_files_deletion_reference_update` BEFORE UPDATE ON `production_flow_files` FOR EACH ROW BEGIN
 IF (NOT(NEW.file_version_id <=> OLD.file_version_id)) AND EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('version:',NEW.file_version_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_asset_lineage_deletion_reference_insert` BEFORE INSERT ON `asset_lineage` FOR EACH ROW BEGIN
 IF EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('version:',NEW.output_version_id) OR scope_id=CONCAT('version:',NEW.source_version_id) OR scope_id=CONCAT('file:',NEW.source_asset_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_asset_lineage_deletion_reference_update` BEFORE UPDATE ON `asset_lineage` FOR EACH ROW BEGIN
 IF (NOT(NEW.output_version_id <=> OLD.output_version_id) OR NOT(NEW.source_version_id <=> OLD.source_version_id) OR NOT(NEW.source_asset_id <=> OLD.source_asset_id)) AND EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('version:',NEW.output_version_id) OR scope_id=CONCAT('version:',NEW.source_version_id) OR scope_id=CONCAT('file:',NEW.source_asset_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_material_standards_deletion_reference_insert` BEFORE INSERT ON `material_standards` FOR EACH ROW BEGIN
 IF EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('version:',NEW.file_version_id) OR scope_id=CONCAT('file:',NEW.logical_file_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_material_standards_deletion_reference_update` BEFORE UPDATE ON `material_standards` FOR EACH ROW BEGIN
 IF (NOT(NEW.file_version_id <=> OLD.file_version_id) OR NOT(NEW.logical_file_id <=> OLD.logical_file_id)) AND EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('version:',NEW.file_version_id) OR scope_id=CONCAT('file:',NEW.logical_file_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_production_checkpoints_deletion_reference_insert` BEFORE INSERT ON `production_checkpoints` FOR EACH ROW BEGIN
 IF EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('version:',NEW.project_file_version_id) OR scope_id=CONCAT('version:',NEW.preview_file_version_id) OR scope_id=CONCAT('version:',NEW.manifest_file_version_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_production_checkpoints_deletion_reference_update` BEFORE UPDATE ON `production_checkpoints` FOR EACH ROW BEGIN
 IF (NOT(NEW.project_file_version_id <=> OLD.project_file_version_id) OR NOT(NEW.preview_file_version_id <=> OLD.preview_file_version_id) OR NOT(NEW.manifest_file_version_id <=> OLD.manifest_file_version_id)) AND EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('version:',NEW.project_file_version_id) OR scope_id=CONCAT('version:',NEW.preview_file_version_id) OR scope_id=CONCAT('version:',NEW.manifest_file_version_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_production_checkpoint_drafts_deletion_reference_insert` BEFORE INSERT ON `production_checkpoint_drafts` FOR EACH ROW BEGIN
 IF EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('version:',NEW.project_file_version_id) OR scope_id=CONCAT('version:',NEW.preview_file_version_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_production_checkpoint_drafts_deletion_reference_update` BEFORE UPDATE ON `production_checkpoint_drafts` FOR EACH ROW BEGIN
 IF (NOT(NEW.project_file_version_id <=> OLD.project_file_version_id) OR NOT(NEW.preview_file_version_id <=> OLD.preview_file_version_id)) AND EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('version:',NEW.project_file_version_id) OR scope_id=CONCAT('version:',NEW.preview_file_version_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_quality_rounds_deletion_reference_insert` BEFORE INSERT ON `quality_rounds` FOR EACH ROW BEGIN
 IF EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('version:',NEW.file_id) OR scope_id=CONCAT('version:',NEW.report_file_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_quality_rounds_deletion_reference_update` BEFORE UPDATE ON `quality_rounds` FOR EACH ROW BEGIN
 IF (NOT(NEW.file_id <=> OLD.file_id) OR NOT(NEW.report_file_id <=> OLD.report_file_id)) AND EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('version:',NEW.file_id) OR scope_id=CONCAT('version:',NEW.report_file_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_deliveries_deletion_reference_insert` BEFORE INSERT ON `deliveries` FOR EACH ROW BEGIN
 IF EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('version:',NEW.file_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_deliveries_deletion_reference_update` BEFORE UPDATE ON `deliveries` FOR EACH ROW BEGIN
 IF (NOT(NEW.file_id <=> OLD.file_id)) AND EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('version:',NEW.file_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_feedback_deletion_reference_insert` BEFORE INSERT ON `feedback` FOR EACH ROW BEGIN
 IF EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('version:',NEW.file_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_feedback_deletion_reference_update` BEFORE UPDATE ON `feedback` FOR EACH ROW BEGIN
 IF (NOT(NEW.file_id <=> OLD.file_id)) AND EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('version:',NEW.file_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_share_links_deletion_reference_insert` BEFORE INSERT ON `share_links` FOR EACH ROW BEGIN
 IF EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('version:',NEW.file_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_share_links_deletion_reference_update` BEFORE UPDATE ON `share_links` FOR EACH ROW BEGIN
 IF (NOT(NEW.file_id <=> OLD.file_id)) AND EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('version:',NEW.file_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_production_final_submissions_deletion_reference_insert` BEFORE INSERT ON `production_final_submissions` FOR EACH ROW BEGIN
 IF EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('version:',NEW.final_version_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_production_final_submissions_deletion_reference_update` BEFORE UPDATE ON `production_final_submissions` FOR EACH ROW BEGIN
 IF (NOT(NEW.final_version_id <=> OLD.final_version_id)) AND EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('version:',NEW.final_version_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_asset_collection_files_deletion_reference_insert` BEFORE INSERT ON `asset_collection_files` FOR EACH ROW BEGIN
 IF EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('file:',NEW.file_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_asset_collection_files_deletion_reference_update` BEFORE UPDATE ON `asset_collection_files` FOR EACH ROW BEGIN
 IF (NOT(NEW.file_id <=> OLD.file_id)) AND EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('file:',NEW.file_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_asset_collections_deletion_reference_insert` BEFORE INSERT ON `asset_collections` FOR EACH ROW BEGIN
 IF EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('file:',NEW.final_file_id) OR scope_id=CONCAT('file:',NEW.cover_file_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_asset_collections_deletion_reference_update` BEFORE UPDATE ON `asset_collections` FOR EACH ROW BEGIN
 IF (NOT(NEW.final_file_id <=> OLD.final_file_id) OR NOT(NEW.cover_file_id <=> OLD.cover_file_id)) AND EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('file:',NEW.final_file_id) OR scope_id=CONCAT('file:',NEW.cover_file_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_publish_records_deletion_reference_insert` BEFORE INSERT ON `publish_records` FOR EACH ROW BEGIN
 IF EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('version:',NEW.file_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;

--> statement-breakpoint
CREATE TRIGGER `trg_publish_records_deletion_reference_update` BEFORE UPDATE ON `publish_records` FOR EACH ROW BEGIN
 IF (NOT(NEW.file_id <=> OLD.file_id)) AND EXISTS(SELECT 1 FROM business_deletion_locks WHERE scope_id=CONCAT('version:',NEW.file_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Business deletion has locked this reference'; END IF;
END;
