import snapshot from "../../db/mysql/schema-contract.json" with {type:'json'};
export function schemaForVersion(version='0009') {
 if (!['0001','0002','0003','0004','0005','0006','0007','0008','0009'].includes(version)) throw Error('Unknown schema version');
 const schema=structuredClone(snapshot);
 if(version<'0009')for(const name of Object.keys(schema.tables))if(name.startsWith('deseret_'))delete schema.tables[name];
 if(version<'0008'&&schema.tables.direct_upload_sessions){delete schema.tables.direct_upload_sessions.columns.completion_source;delete schema.tables.direct_upload_sessions.checkConstraints.direct_upload_completion_source;}
 if(version<'0007')delete schema.tables.direct_upload_sessions;
 if(version<'0006'){delete schema.tables.admin_log_deletion_previews;delete schema.tables.admin_log_deletion_receipts;}
 if(version<'0005'){
  delete schema.tables.audit_request_metadata;
  delete schema.tables.audit_logs.columns.request_id;
  delete schema.tables.audit_logs.indexes.idx_audit_logs_request;
 }
 if(version<'0004'){
  delete schema.tables.clients.columns.created_by;
  delete schema.tables.clients.columns.creator_maintenance_active;
  delete schema.tables.projects.columns.deleted_at;
  for(const name of Object.keys(schema.tables))if(name.startsWith('business_deletion_'))delete schema.tables[name];
 }
 return schema;
}
// The DML-only Test runner has an administrator-precreated rates fixture (2026-09-29).
// It is not application data and is accepted only on the exact Test database after full shape comparison.
async function verifyKnownTestFixture(c, tables) {
 const fixture=tables.find(table=>table.TABLE_NAME==='mysql_test_rates_fixture');
 if(!fixture)return false;
 const [[identity]]=await c.query('SELECT DATABASE() AS database_name');
 if(identity.database_name!=='lifewood_aigc_test'&&!(process.env.LIFEWOOD_ENV==='audit'&&identity.database_name==='lifewood_aigc_audit'))throw Error('Test fixture is forbidden outside Test');
 const original=tables.find(table=>table.TABLE_NAME==='security_rate_limits');
 if(!original||fixture.ENGINE!=='InnoDB'||fixture.TABLE_COLLATION!=='utf8mb4_0900_bin'||fixture.ENGINE!==original.ENGINE||fixture.TABLE_COLLATION!==original.TABLE_COLLATION)throw Error('Test fixture engine or collation mismatch');
 const columns=async table=>(await c.query('SHOW FULL COLUMNS FROM `'+table+'`'))[0].map(row=>Object.fromEntries(['Field','Type','Collation','Null','Key','Default','Extra','Comment'].map(key=>[key,row[key]])));
 const indexes=async table=>(await c.query('SHOW INDEX FROM `'+table+'`'))[0].map(row=>Object.fromEntries(['Key_name','Non_unique','Seq_in_index','Column_name','Collation','Sub_part','Packed','Null','Index_type','Comment','Index_comment','Visible','Expression'].map(key=>[key,row[key]??null]))).sort((a,b)=>a.Key_name.localeCompare(b.Key_name)||a.Seq_in_index-b.Seq_in_index);
 if(JSON.stringify(await columns('mysql_test_rates_fixture'))!==JSON.stringify(await columns('security_rate_limits')))throw Error('Test fixture columns mismatch');
 if(JSON.stringify(await indexes('mysql_test_rates_fixture'))!==JSON.stringify(await indexes('security_rate_limits')))throw Error('Test fixture indexes mismatch');
 return true;
}
export async function verifySchema(c, version='0009'){
 const snapshot=schemaForVersion(version);
 const [tables]=await c.query('SELECT TABLE_NAME,ENGINE,TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()');
 const knownTestFixture=await verifyKnownTestFixture(c,tables);
 const business=tables.filter(t=>!['_lifewood_migrations','_lifewood_bootstrap','_lifewood_test_run',...(knownTestFixture?['mysql_test_rates_fixture']:[])].includes(t.TABLE_NAME));
 if(business.length!==Object.keys(snapshot.tables).length)throw Error('Unexpected business table count');
 for(const source of Object.values(snapshot.tables)){
  const actual=business.find(t=>t.TABLE_NAME===source.name);if(!actual||actual.ENGINE!=='InnoDB'||actual.TABLE_COLLATION!=='utf8mb4_0900_bin')throw Error('Table engine or collation mismatch: '+source.name);
  const [columns]=await c.execute('SELECT COLUMN_NAME,DATA_TYPE,IS_NULLABLE,COLUMN_KEY,CHARACTER_MAXIMUM_LENGTH FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',[source.name]);
  if(columns.filter(c=>!c.COLUMN_NAME.startsWith('__uq_')).length!==Object.keys(source.columns).length)throw Error('Column count mismatch: '+source.name);
  for(const field of Object.values(source.columns)){
   const col=columns.find(c=>c.COLUMN_NAME===field.name);if(!col||col.IS_NULLABLE!==(field.notNull?'NO':'YES')||(field.primaryKey&&col.COLUMN_KEY!=='PRI'))throw Error('Column definition mismatch: '+source.name+'.'+field.name);
   const expected=field.type==='integer'?'bigint':field.type==='real'?'double':field.primaryKey||field.name==='id'||['_id','_hash','_salt','_email','_at'].some(s=>field.name.endsWith(s))||['email','key','created_by','updated_by','owner_email','due_date'].includes(field.name)?'varchar':'longtext';
   if(col.DATA_TYPE!==expected)throw Error('Column type mismatch: '+source.name+'.'+field.name);
   if(expected==='varchar'&&col.CHARACTER_MAXIMUM_LENGTH!==(field.name.includes('email')?254:255))throw Error('Column width mismatch');
  }
  const [indexes]=await c.execute('SELECT DISTINCT INDEX_NAME,NON_UNIQUE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',[source.name]);
  const expectedIndexes=[...Object.values(source.indexes),...(source.name==='aigc_folders'?[{name:'idx_aigc_folders_sibling_name',isUnique:true}]:[])];
  for(const index of expectedIndexes)if(!indexes.some(i=>i.INDEX_NAME===index.name&&Boolean(i.NON_UNIQUE)===!index.isUnique))throw Error('Missing index: '+index.name);
  if(indexes.length!==expectedIndexes.length+Number(Object.values(source.columns).some(c=>c.primaryKey)))throw Error('Unexpected indexes: '+source.name);
 }
 const [checks]=await c.query("SELECT CONSTRAINT_NAME,ENFORCED FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND CONSTRAINT_TYPE='CHECK'");
 for(const table of Object.values(snapshot.tables))for(const check of Object.values(table.checkConstraints))if(!checks.some(c=>c.CONSTRAINT_NAME===check.name&&c.ENFORCED==='YES'))throw Error('Missing enforced check: '+check.name);
 const [triggers]=await c.query('SELECT TRIGGER_NAME,ACTION_TIMING,EVENT_MANIPULATION FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()');
 if(!triggers.some(t=>t.TRIGGER_NAME==='trg_notifications_recipient_account'&&t.ACTION_TIMING==='BEFORE'&&t.EVENT_MANIPULATION==='INSERT'))throw Error('Administrator must install the notification trigger');
}
