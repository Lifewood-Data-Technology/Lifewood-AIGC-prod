-- Additive troubleshooting marker: who completed a direct upload (the uploader, the background finalizer or an operator reconciliation).
-- Historical sessions retain NULL; no invented backfill. The application never returns this column to the browser.
ALTER TABLE `direct_upload_sessions` ADD COLUMN `completion_source` LONGTEXT NULL, ADD CONSTRAINT `direct_upload_completion_source` CHECK (`completion_source` IS NULL OR `completion_source` IN ('user', 'background', 'operator'));
