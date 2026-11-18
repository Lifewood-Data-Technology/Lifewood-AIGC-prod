-- Preserve SQLite UPDATE OF checks for unchanged assignments through the MySQL driver.
CREATE TRIGGER `trg_project_videos_assignment_scope` BEFORE UPDATE ON `project_videos` FOR EACH ROW BEGIN
 IF COALESCE(@lifewood_relation_project_videos,0)=1 AND (NOT EXISTS (SELECT 1 FROM projects WHERE id=NEW.project_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Project video requires a valid project'; END IF;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_language_projects_assignment_scope` BEFORE UPDATE ON `language_projects` FOR EACH ROW BEGIN
 IF COALESCE(@lifewood_relation_language_projects,0)=1 AND (NOT EXISTS (SELECT 1 FROM project_videos WHERE id=NEW.video_id AND project_id=NEW.project_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Language task requires a video in the same project'; END IF;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_aigc_files_assignment_scope` BEFORE UPDATE ON `aigc_files` FOR EACH ROW BEGIN
 IF COALESCE(@lifewood_relation_aigc_files,0)=1 AND (NOT EXISTS (SELECT 1 FROM aigc_folders WHERE id=NEW.folder_id AND deleted_at IS NULL) OR (trim(NEW.language_project_id)<>'' AND NOT EXISTS (SELECT 1 FROM aigc_folders WHERE id=NEW.folder_id AND language_project_id=NEW.language_project_id))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='File requires an active folder with matching language scope'; END IF;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_notifications_assignment_scope` BEFORE UPDATE ON `notifications` FOR EACH ROW BEGIN
 IF COALESCE(@lifewood_relation_notifications,0)=1 AND (NOT EXISTS (SELECT 1 FROM accounts WHERE email=NEW.recipient_email)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Notification requires a valid recipient'; END IF;
END;
