import {writeFile} from 'node:fs/promises';
// The source constraints are declared in ensureDataIntegrity in db/backend.ts.
// MySQL has no UPDATE OF trigger; only relationship changes need revalidation.
const rules=[
 {table:'project_videos',prefix:'trg_project_videos_parent',fields:['project_id'],invalid:'NOT EXISTS (SELECT 1 FROM projects WHERE id=NEW.project_id)',message:'Project video requires a valid project',update:true},
 {table:'language_projects',prefix:'trg_language_projects_scope',fields:['project_id','video_id'],invalid:'NOT EXISTS (SELECT 1 FROM project_videos WHERE id=NEW.video_id AND project_id=NEW.project_id)',message:'Language task requires a video in the same project',update:true},
 {table:'aigc_files',prefix:'trg_aigc_files_scope',fields:['folder_id','language_project_id'],invalid:"NOT EXISTS (SELECT 1 FROM aigc_folders WHERE id=NEW.folder_id AND deleted_at IS NULL) OR (trim(NEW.language_project_id)<>'' AND NOT EXISTS (SELECT 1 FROM aigc_folders WHERE id=NEW.folder_id AND language_project_id=NEW.language_project_id))",message:'File requires an active folder with matching language scope',update:true},
 {table:'notifications',prefix:'trg_notifications_recipient',fields:['recipient_email'],invalid:'NOT EXISTS (SELECT 1 FROM accounts WHERE email=NEW.recipient_email)',message:'Notification requires a valid recipient',update:true},
 {table:'asset_collection_files',prefix:'trg_asset_collection_files_scope',invalid:"NOT EXISTS (SELECT 1 FROM asset_collections WHERE id=NEW.collection_id) OR NOT EXISTS (SELECT 1 FROM aigc_files WHERE id=NEW.file_id AND source='internal')",message:'Asset collection member requires a valid collection and library file'},
 {table:'asset_lineage',prefix:'trg_asset_lineage_scope',invalid:"NOT EXISTS (SELECT 1 FROM aigc_file_versions WHERE id=NEW.output_version_id AND file_id=NEW.output_file_id) OR NOT EXISTS (SELECT 1 FROM aigc_files WHERE id=NEW.source_asset_id AND source='internal')",message:'Asset lineage references are invalid'},
];
const statements=[];
for(const rule of rules)for(const event of rule.update?['INSERT','UPDATE']:['INSERT']){
 const changed=event==='UPDATE'?'('+rule.fields.map(f=>`NOT (NEW.\`${f}\` <=> OLD.\`${f}\`)`).join(' OR ')+') AND ':'';
 statements.push(`CREATE TRIGGER \`${rule.prefix}_${event.toLowerCase()}\` BEFORE ${event} ON \`${rule.table}\` FOR EACH ROW BEGIN\n IF ${changed}(${rule.invalid}) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='${rule.message}'; END IF;\nEND`);
}
await writeFile(new URL('../../db/mysql/migrations/0002-relationship-guards.sql',import.meta.url),'-- Relationship integrity; no data repair or backfill. Requires an administrator when binary logging is enabled.\n'+statements.join(';\n--> statement-breakpoint\n')+';\n');
console.log('Generated 10 relationship integrity triggers');
