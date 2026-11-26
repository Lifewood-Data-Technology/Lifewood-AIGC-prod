import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export const migrationNames = ['0001-business-schema.sql', '0002-relationship-guards.sql', '0003-assignment-guards.sql', '0004-business-lifecycle.sql', '0005-audit-request-metadata.sql', '0006-admin-log-deletion.sql', '0007-direct-uploads.sql', '0008-upload-completion-source.sql', '0009-deseret-integration.sql', '0010-deseret-production-archives.sql', '0011-deseret-publisher-review-task-status.sql'];
export const currentSchemaVersion = '0011';
export async function readMigrations() {
  return Promise.all(migrationNames.map(async name => {
    const source = await readFile(new URL('../../db/mysql/migrations/' + name, import.meta.url), 'utf8');
    return { version: name.slice(0, 4), digest: createHash('sha256').update(source).digest('hex'), statements: source.split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean) };
  }));
}
export function assertCompleteMigrationHistory(history) {
  if (history.length !== migrationNames.length || history.some((row, index) => row.version !== migrationNames[index].slice(0, 4) || row.completed !== 1)) throw Error('Complete and verify the schema migration before initialization');
}
