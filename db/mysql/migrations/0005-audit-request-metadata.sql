-- Additive request metadata only. Historical audit records retain NULL; no invented backfill.
ALTER TABLE `audit_logs` ADD COLUMN `request_id` VARCHAR(255) NULL, ADD KEY `idx_audit_logs_request` (`request_id`);
--> statement-breakpoint
CREATE TABLE `audit_request_metadata` (
  `request_id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `ip_address` LONGTEXT NULL,
  `outcome` LONGTEXT NULL,
  `duration_ms` BIGINT NULL,
  `error_code` LONGTEXT NULL,
  CONSTRAINT `audit_request_outcome` CHECK (`outcome` IS NULL OR `outcome` IN ('success', 'failure', 'unconfirmed')),
  CONSTRAINT `audit_request_duration` CHECK (`duration_ms` IS NULL OR `duration_ms` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
