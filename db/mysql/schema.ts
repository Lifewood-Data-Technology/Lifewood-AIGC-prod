import { sql } from 'drizzle-orm';
import { mysqlTable, varchar, longtext, bigint, double, binary, index, uniqueIndex, check, type AnyMySqlColumn } from 'drizzle-orm/mysql-core';
import snapshot from "./schema-contract.json";

/** Current business schema only. Historical data/backfill migrations are never replayed. */
export const sourceTables = snapshot.tables;
export function columnKind(table: string, name: string, column: { type: string; primaryKey?: boolean }) {
  if (column.type === 'integer') return 'bigint';
  if (column.type === 'real') return 'double';
  if (column.primaryKey || name === 'id' || name.endsWith('_id') || name.endsWith('_hash') || name.endsWith('_salt') || name === 'email' || name.endsWith('_email') || name === 'key' || name.endsWith('_at') || ['created_by','updated_by','owner_email','due_date'].includes(name)) return 'varchar';
  return 'longtext';
}
export function hashExpression(columns: string[], condition?: string) {
  const nullable = columns.map(c => `\`${c}\` IS NULL`).join(' OR ');
  return `CASE WHEN ${condition ? `NOT (${condition}) OR ` : ''}${nullable} THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(${columns.map(c=>`\`${c}\``).join(',')}) AS CHAR CHARACTER SET utf8mb4),256)) END`;
}
export const tables = Object.fromEntries(Object.values(sourceTables).map(table => {
  const columns: Record<string, ReturnType<typeof longtext> | ReturnType<typeof varchar> | ReturnType<typeof bigint> | ReturnType<typeof double> | ReturnType<typeof binary>> = {};
  for (const col of Object.values(table.columns)) {
    const kind = columnKind(table.name, col.name, col);
    let c = kind === 'bigint' ? bigint(col.name,{mode:'number'}) : kind === 'double' ? double(col.name) : kind === 'varchar' ? varchar(col.name,{length: col.name.includes('email') ? 254 : 255}) : longtext(col.name);
    if (col.notNull) c=c.notNull();
    if (col.primaryKey) c=c.primaryKey();
    if ('autoincrement' in col && col.autoincrement && kind==='bigint') c=bigint(col.name,{mode:'number'}).autoincrement().primaryKey();
    if ('default' in col) c=c.default(sql.raw(String(col.default)));
    columns[col.name]=c;
  }
  const indexes=Object.values(table.indexes) as {name:string;columns:string[];isUnique:boolean;where?:string}[];
  for(const idx of indexes) if(idx.isUnique) columns['__uq_'+idx.name]=binary('__uq_'+idx.name,{length:32}).generatedAlwaysAs(sql.raw(hashExpression(idx.columns,idx.where?.replaceAll('"','`'))),{mode:'stored'});
  if(table.name==='aigc_folders')columns.__uq_live_sibling=binary('__uq_live_sibling',{length:32}).generatedAlwaysAs(sql.raw("CASE WHEN deleted_at IS NOT NULL THEN NULL ELSE UNHEX(SHA2(CAST(JSON_ARRAY(language_project_id,COALESCE(parent_folder_id,''),name) AS CHAR CHARACTER SET utf8mb4),256)) END"),{mode:'stored'});
  return [table.name,mysqlTable(table.name,columns,t=>[
    ...indexes.map(idx=>idx.isUnique?uniqueIndex(idx.name).on(t['__uq_'+idx.name] as AnyMySqlColumn):index(idx.name).on(...idx.columns.map(c=>columnKind(table.name,c,(table.columns as Record<string,{type:string;primaryKey?:boolean}>)[c])==='longtext'?sql.raw('`'+c+'`(191)'):t[c] as AnyMySqlColumn) as [AnyMySqlColumn | ReturnType<typeof sql.raw>,...(AnyMySqlColumn | ReturnType<typeof sql.raw>)[]])),
    ...(table.name==='aigc_folders'?[uniqueIndex('idx_aigc_folders_sibling_name').on(t.__uq_live_sibling as AnyMySqlColumn)]:[]),
    ...Object.values(table.checkConstraints).map(c=>check(c.name,sql.raw(c.value.replaceAll('"','`')))),
  ])];
}));
