-- Relationship integrity; no data repair or backfill. Requires an administrator when binary logging is enabled.
CREATE TRIGGER `trg_project_videos_parent_insert` BEFORE INSERT ON `project_videos` FOR EACH ROW BEGIN
 IF (NOT EXISTS (SELECT 1 FROM projects WHERE id=NEW.project_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Project video requires a valid project'; END IF;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_project_videos_parent_update` BEFORE UPDATE ON `project_videos` FOR EACH ROW BEGIN
 IF (NOT (NEW.`project_id` <=> OLD.`project_id`)) AND (NOT EXISTS (SELECT 1 FROM projects WHERE id=NEW.project_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Project video requires a valid project'; END IF;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_language_projects_scope_insert` BEFORE INSERT ON `language_projects` FOR EACH ROW BEGIN
 IF (NOT EXISTS (SELECT 1 FROM project_videos WHERE id=NEW.video_id AND project_id=NEW.project_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Language task requires a video in the same project'; END IF;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_language_projects_scope_update` BEFORE UPDATE ON `language_projects` FOR EACH ROW BEGIN
 IF (NOT (NEW.`project_id` <=> OLD.`project_id`) OR NOT (NEW.`video_id` <=> OLD.`video_id`)) AND (NOT EXISTS (SELECT 1 FROM project_videos WHERE id=NEW.video_id AND project_id=NEW.project_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Language task requires a video in the same project'; END IF;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_aigc_files_scope_insert` BEFORE INSERT ON `aigc_files` FOR EACH ROW BEGIN
 IF (NOT EXISTS (SELECT 1 FROM aigc_folders WHERE id=NEW.folder_id AND deleted_at IS NULL) OR (trim(NEW.language_project_id)<>'' AND NOT EXISTS (SELECT 1 FROM aigc_folders WHERE id=NEW.folder_id AND language_project_id=NEW.language_project_id))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='File requires an active folder with matching language scope'; END IF;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_aigc_files_scope_update` BEFORE UPDATE ON `aigc_files` FOR EACH ROW BEGIN
 IF (NOT (NEW.`folder_id` <=> OLD.`folder_id`) OR NOT (NEW.`language_project_id` <=> OLD.`language_project_id`)) AND (NOT EXISTS (SELECT 1 FROM aigc_folders WHERE id=NEW.folder_id AND deleted_at IS NULL) OR (trim(NEW.language_project_id)<>'' AND NOT EXISTS (SELECT 1 FROM aigc_folders WHERE id=NEW.folder_id AND language_project_id=NEW.language_project_id))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='File requires an active folder with matching language scope'; END IF;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_notifications_recipient_insert` BEFORE INSERT ON `notifications` FOR EACH ROW BEGIN
 IF (NOT EXISTS (SELECT 1 FROM accounts WHERE email=NEW.recipient_email)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Notification requires a valid recipient'; END IF;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_notifications_recipient_update` BEFORE UPDATE ON `notifications` FOR EACH ROW BEGIN
 IF (NOT (NEW.`recipient_email` <=> OLD.`recipient_email`)) AND (NOT EXISTS (SELECT 1 FROM accounts WHERE email=NEW.recipient_email)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Notification requires a valid recipient'; END IF;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_asset_collection_files_scope_insert` BEFORE INSERT ON `asset_collection_files` FOR EACH ROW BEGIN
 IF (NOT EXISTS (SELECT 1 FROM asset_collections WHERE id=NEW.collection_id) OR NOT EXISTS (SELECT 1 FROM aigc_files WHERE id=NEW.file_id AND source='internal')) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Asset collection member requires a valid collection and library file'; END IF;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_asset_lineage_scope_insert` BEFORE INSERT ON `asset_lineage` FOR EACH ROW BEGIN
 IF (NOT EXISTS (SELECT 1 FROM aigc_file_versions WHERE id=NEW.output_version_id AND file_id=NEW.output_file_id) OR NOT EXISTS (SELECT 1 FROM aigc_files WHERE id=NEW.source_asset_id AND source='internal')) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Asset lineage references are invalid'; END IF;
END;
