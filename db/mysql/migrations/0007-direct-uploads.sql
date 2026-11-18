-- Additive direct-transfer reservations and atomic completion receipts.
CREATE TABLE `direct_upload_sessions` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `registration_id` VARCHAR(255) NOT NULL,
  `actor_email` VARCHAR(254) NOT NULL,
  `request_hash` VARCHAR(255) NOT NULL,
  `payload_json` LONGTEXT NOT NULL,
  `assets_json` LONGTEXT NOT NULL,
  `scopes_json` LONGTEXT NOT NULL,
  `authority_json` LONGTEXT NOT NULL,
  `state` LONGTEXT NOT NULL,
  `result_json` LONGTEXT,
  `claim_id` VARCHAR(255),
  `lease_expires_at` VARCHAR(255),
  `expires_at` VARCHAR(255) NOT NULL,
  `created_at` VARCHAR(255) NOT NULL,
  `updated_at` VARCHAR(255) NOT NULL,
  `size_bytes` BIGINT NOT NULL,
  `cleaned_at` VARCHAR(255) NULL,
  KEY `idx_direct_upload_owner` (`actor_email`,`expires_at`),
  KEY `idx_direct_upload_expiry` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
