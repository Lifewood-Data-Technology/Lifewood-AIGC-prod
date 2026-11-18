import {mkdir,readFile,writeFile,lstat,chmod} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseEnv} from 'node:util';
import {createHash} from 'node:crypto';

// Planning inventory only: no DDL, DML, object writes, downloads or deletion.
export function argumentsFor(args){
  if(args.length!==4||args[0]!=='--env'||args[2]!=='--out'||!args[1]||!args[3])throw Error('USAGE');
  return {config:resolve(args[1]),out:resolve(args[3])};
}
export function checkSource(env){
  if(env.LIFEWOOD_ENV!=='test'||env.MYSQL_DATABASE!=='lifewood_aigc_test'||env.WASABI_BUCKET!=='aigc-dev'||env.WASABI_PREFIX!=='lifewood-test/app/')throw Error('NOT_UBUNTU_TEST_SOURCE');
}
export function tableIdentifier(name){
  if(!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(name))throw Error('INVALID_TABLE_NAME');
  return '`'+name+'`';
}
export async function versionInventory(send,bucket,prefix,limit=100000){
  const items=[],seen=new Set();let keyMarker,versionMarker;
  for(;;){
    const page=await send({Bucket:bucket,Prefix:prefix,MaxKeys:1000,KeyMarker:keyMarker,VersionIdMarker:versionMarker});
    for(const [type,rows] of [['version',page.Versions||[]],['delete-marker',page.DeleteMarkers||[]]])for(const row of rows){
      if(typeof row.Key!=='string'||!row.Key.startsWith(prefix)||typeof row.VersionId!=='string'||typeof row.IsLatest!=='boolean'||(type==='version'&&(!Number.isSafeInteger(row.Size)||row.Size<0)))throw Error('INVALID_STORAGE_INVENTORY');
      items.push({type,key:row.Key,versionId:row.VersionId,isLatest:row.IsLatest,bytes:row.Size,etag:row.ETag,modified:row.LastModified});
      if(items.length>limit)throw Error('INVENTORY_LIMIT');
    }
    if(!page.IsTruncated)return items;
    const cursor=JSON.stringify([page.NextKeyMarker,page.NextVersionIdMarker]);
    if(!page.NextKeyMarker||seen.has(cursor))throw Error('INVALID_STORAGE_CURSOR');
    seen.add(cursor);keyMarker=page.NextKeyMarker;versionMarker=page.NextVersionIdMarker;
  }
}
const cap=100000;
export async function run(args){
  const {config,out}=argumentsFor(args);
  const info=await lstat(config);
  if(!info.isFile()||info.isSymbolicLink()||(process.platform!=='win32'&&(info.mode&0o077)))throw Error('PRIVATE_ENV_REQUIRED');
  const env=parseEnv(await readFile(config,'utf8'));checkSource(env);
  const {mysqlOptions}=await import('../../db/mysql/config.ts');
  const options=mysqlOptions(env); // Reuse strict resource/TLS validation, never process.env overrides.
  await mkdir(out,{mode:0o700}); // An existing output directory is rejected, never overwritten.
  await chmod(out,0o700);
  const mysql=(await import('mysql2/promise')).default;
  const sdk=await import('@aws-sdk/client-s3');
  let db,s3;
  const report={format:1,kind:'online-planning-inventory-not-backup',startedAt:new Date().toISOString(),source:{environment:'test',database:env.MYSQL_DATABASE,bucket:env.WASABI_BUCKET,prefix:env.WASABI_PREFIX,region:env.WASABI_REGION,endpoint:env.WASABI_ENDPOINT},complete:false};
  try{
    db=await mysql.createConnection({...options,connectTimeout:10000});
    await db.query('SET SESSION MAX_EXECUTION_TIME=30000');
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const [[server]]=await db.query('SELECT VERSION() AS version');report.mysqlVersion=server.version;
    const [tables]=await db.query("SELECT TABLE_NAME AS name,ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME");
    const names=new Set(tables.map(t=>t.name));report.tables=[];
    for(const table of tables){
      const [[count]]=await db.query('SELECT COUNT(*) AS n FROM '+tableIdentifier(table.name));
      report.tables.push({...table,rows:String(count.n)});
    }
    async function bounded(table,columns){
      if(!names.has(table))return [];
      const [rows]=await db.query('SELECT '+columns+' FROM '+tableIdentifier(table)+' LIMIT '+(cap+1));
      if(rows.length>cap)throw Error('INVENTORY_LIMIT');return rows;
    }
    report.migrations=await bounded('_lifewood_migrations','version,sha256,completed');
    report.projects=await bounded('projects','id,name,status,deleted_at');
    report.storageObjects=await bounded('aigc_storage_objects','id,provider,bucket_name,region_name,endpoint_url,object_key,etag');
    report.fileVersions=await bounded('aigc_file_versions','id,file_id,version_number,storage_object_id,size_bytes,checksum_sha256');
    report.background=[];
    for(const table of ['direct_upload_sessions','deseret_material_tasks','deseret_outbox'])if(names.has(table)){
      const [states]=await db.query('SELECT state,COUNT(*) AS count FROM '+tableIdentifier(table)+' GROUP BY state');
      report.background.push({table,states});
    }
    const [triggers]=await db.query('SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()');report.triggers=triggers;
    await db.rollback();await db.end();db=undefined;
    s3=new sdk.S3Client({endpoint:env.WASABI_ENDPOINT,region:env.WASABI_REGION,credentials:{accessKeyId:env.WASABI_ACCESS_KEY_ID,secretAccessKey:env.WASABI_SECRET_ACCESS_KEY},maxAttempts:2});
    const send=command=>s3.send(command,{abortSignal:AbortSignal.timeout(20000)});
    report.versioning=(await send(new sdk.GetBucketVersioningCommand({Bucket:env.WASABI_BUCKET}))).Status||'Disabled';
    report.objects=await versionInventory(input=>send(new sdk.ListObjectVersionsCommand(input)),env.WASABI_BUCKET,env.WASABI_PREFIX);
    const multipart=await send(new sdk.ListMultipartUploadsCommand({Bucket:env.WASABI_BUCKET,Prefix:env.WASABI_PREFIX,MaxUploads:1000}));
    report.multipart={countOnFirstPage:multipart.Uploads?.length||0,truncated:!!multipart.IsTruncated};
    report.complete=true;report.finishedAt=new Date().toISOString();
    const payload=JSON.stringify(report,null,2);await writeFile(join(out,'inventory.private.json'),payload,{flag:'wx',mode:0o600});
    const latest=report.objects.filter(o=>o.type==='version'&&o.isLatest);
    const summary={kind:report.kind,source:report.source,mysqlVersion:report.mysqlVersion,tableCount:report.tables.length,projectCount:report.projects.length,fileVersionCount:report.fileVersions.length,storageReferenceCount:report.storageObjects.length,otherBucketReferences:report.storageObjects.filter(o=>o.bucket_name!==env.WASABI_BUCKET).length,versioning:report.versioning,latestObjects:latest.length,latestBytes:latest.reduce((sum,o)=>sum+BigInt(o.bytes),0n).toString(),objectVersions:report.objects.filter(o=>o.type==='version').length,deleteMarkers:report.objects.filter(o=>o.type==='delete-marker').length,multipart:report.multipart,inventorySha256:createHash('sha256').update(payload).digest('hex'),startedAt:report.startedAt,finishedAt:report.finishedAt,complete:true,limitations:['Online planning inventory; database and storage are not an atomic backup.','No file bodies downloaded or checksums independently verified.','Project selection and dependency closure remain unapproved.','No source or destination resources changed.']};
    await writeFile(join(out,'summary.json'),JSON.stringify(summary,null,2),{flag:'wx',mode:0o600});
    console.log(JSON.stringify({complete:true,summary:join(out,'summary.json'),privateInventory:join(out,'inventory.private.json')}));
  }finally{if(db){await db.rollback().catch(()=>{});await db.end().catch(()=>{});}s3?.destroy();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.includes('--help'))console.log('Node 24: node scripts/deployment/inventory-test-source.mjs --env /private/test.env --out /private/new-inventory-directory\nRead-only Ubuntu Test inventory. No database or object writes; output must not exist.');
  else run(process.argv.slice(2)).catch(error=>{const known=['USAGE','NOT_UBUNTU_TEST_SOURCE','INVALID_TABLE_NAME','PRIVATE_ENV_REQUIRED','INVALID_STORAGE_INVENTORY','INVALID_STORAGE_CURSOR','INVENTORY_LIMIT'];const code=known.includes(error.message)?error.message:['EEXIST','ENOENT','EACCES'].includes(error.code)?error.code:'INVENTORY_FAILED';console.error(JSON.stringify({complete:false,code,instruction:'No migration performed. Check permissions, resource identity, TLS and connectivity; use a new output directory.'}));process.exitCode=1;});
}
