import fs from 'node:fs';
const snapshot = JSON.parse(fs.readFileSync(new URL("../../db/mysql/schema-contract.json", import.meta.url)));
const q = x => '`' + x.replaceAll('`', '``') + '`';
const hash = (cols, condition) => `CASE WHEN ${condition ? `NOT (${condition}) OR ` : ''}${cols.map(c => q(c) + ' IS NULL').join(' OR ')} THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(${cols.map(q).join(',')}) AS CHAR CHARACTER SET utf8mb4),256)) END`;
const kind = c => c.type === 'integer' ? 'BIGINT' : c.type === 'real' ? 'DOUBLE' : c.primaryKey || c.name === 'id' || c.name.endsWith('_id') || c.name.endsWith('_hash') || c.name.endsWith('_salt') || c.name === 'email' || c.name.endsWith('_email') || c.name === 'key' || c.name.endsWith('_at') || ['created_by', 'updated_by', 'owner_email', 'due_date'].includes(c.name) ? `VARCHAR(${c.name.includes('email') ? 254 : 255})` : 'LONGTEXT';
let statements = [];
for (const t of Object.values(snapshot.tables)) {
    const defs = Object.values(t.columns).map(c => `${q(c.name)} ${kind(c)}${c.notNull ? ' NOT NULL' : ''}${c.autoincrement ? ' AUTO_INCREMENT' : ''}${'default' in c ? ` DEFAULT (${c.default})` : ''}${c.primaryKey ? ' PRIMARY KEY' : ''}`);
    for (const idx of Object.values(t.indexes)) {
        if (idx.isUnique) {
            const generated = '__uq_' + idx.name;
            defs.push(`${q(generated)} BINARY(32) GENERATED ALWAYS AS (${hash(idx.columns, idx.where?.replaceAll('"', '`'))}) STORED`);
            defs.push(`UNIQUE KEY ${q(idx.name)} (${q(generated)})`);
        }
        else
            defs.push(`KEY ${q(idx.name)} (${idx.columns.map(n => q(n) + (kind(t.columns[n]) === 'LONGTEXT' ? '(191)' : '')).join(',')})`);
    }
    if (t.name === 'aigc_folders') {
        // Handwritten index from 0002 is absent from Drizzle snapshots; retain its live-sibling semantics.
        defs.push("`__uq_live_sibling` BINARY(32) GENERATED ALWAYS AS (CASE WHEN deleted_at IS NOT NULL THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(language_project_id,COALESCE(parent_folder_id,''),name) AS CHAR CHARACTER SET utf8mb4),256)) END) STORED");
        defs.push('UNIQUE KEY `idx_aigc_folders_sibling_name` (`__uq_live_sibling`)');
    }
    for (const c of Object.values(t.checkConstraints))
        defs.push(`CONSTRAINT ${q(c.name)} CHECK (${c.value.replaceAll('"', '`')})`);
    statements.push(`CREATE TABLE ${q(t.name)} (\n  ${defs.join(',\n  ')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin`);
}
statements.push("CREATE TRIGGER `trg_notifications_recipient_account` BEFORE INSERT ON `notifications` FOR EACH ROW SET NEW.recipient_account_id = CASE WHEN NEW.recipient_account_id = '' THEN COALESCE((SELECT id FROM accounts WHERE lower(email)=lower(NEW.recipient_email) LIMIT 1),'') ELSE NEW.recipient_account_id END");
// Published migration checksums are immutable. Generate a review artifact only;
// new changes require a new numbered migration, never overwrite 0001.
fs.mkdirSync(new URL('../../output/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('../../output/mysql-schema.generated.sql', import.meta.url), '-- Structure only; no source data, demo seeds, or destructive statements.\n' + statements.join(';\n--> statement-breakpoint\n') + ';\n');
console.log(`Generated ${Object.keys(snapshot.tables).length} tables for review in output/mysql-schema.generated.sql`);
