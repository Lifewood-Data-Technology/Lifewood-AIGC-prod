import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdir,open,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import mysql from 'mysql2/promise';
import snapshot from "../db/mysql/schema-contract.json" with {type:'json'};
import {mysqlOptions} from '../db/mysql/config.ts';
import {derivePasswordHash} from '../db/password-kdf.ts';
import {libraryFolderDefinitions} from '../db/mysql/library-folders.ts';
import {loadEnvironment} from './mysql/environment.mjs';
import {assertCompleteMigrationHistory} from './mysql/migrations.mjs';
loadEnvironment();
const c=await mysql.createConnection(mysqlOptions());
let createdSecret;
try{
 const [[lock]]=await c.query("SELECT GET_LOCK(CONCAT(DATABASE(), ':bootstrap'),0) AS acquired");if(lock.acquired!==1)throw Error('Bootstrap already running');
 const [migrations]=await c.query("SELECT version,completed FROM _lifewood_migrations ORDER BY version");assertCompleteMigrationHistory(migrations);
 await c.query('CREATE TABLE IF NOT EXISTS _lifewood_bootstrap (version VARCHAR(40) PRIMARY KEY,created_at VARCHAR(40) NOT NULL) ENGINE=InnoDB');
 const [existing]=await c.query('SELECT version FROM _lifewood_bootstrap');
 if(existing.length){if(existing.length!==1||existing[0].version!=='0001')throw Error('Unknown initialization state');console.log('Already initialized; no account or data changed');}
 else{
  await c.beginTransaction();
  for(const table of Object.keys(snapshot.tables)){const [[row]]=await c.query('SELECT COUNT(*) AS count FROM `'+table+'`');if(row.count!==0)throw Error('Business schema is not empty; initialization stopped');}
  const now=new Date().toISOString(),email='admin@lifewood.local',password=randomBytes(30).toString('base64url')+'!aA8',salt=randomBytes(16);
  const hash=await derivePasswordHash(password,salt,600000);
  await c.execute("INSERT INTO accounts(id,email,password_hash,name,initials,access_group,status,must_change_password,created_at) VALUES (?,?,?,?,?,'system','active',1,?)",[randomUUID(),email,createHash('sha256').update(randomBytes(32)).digest('hex'),'Local administrator','LA',now]);
  await c.execute('INSERT INTO account_credentials(email,password_hash,password_salt,iterations,updated_at) VALUES (?,?,?,?,?)',[email,hash,salt.toString('hex'),600000,now]);
  for(const [key,value]of [['requireStrongPasswords','true'],['lockRepeatedFailures','true'],['sessionDuration','12'],['securityAlerts','true'],['accountChanges','true'],['weeklyReport','false'],['dataIntegrityVersion','2026-09-20-v4']])await c.execute('INSERT INTO settings(`key`,value,updated_at) VALUES (?,?,?)',[key,value,now]);
  for(const [id,parent,code,zh,en,path,depth,type,sort]of libraryFolderDefinitions)await c.execute('INSERT INTO aigc_folders(id,language_project_id,parent_folder_id,folder_code,name,name_zh,name_en,path_cache,depth,node_type,sort_order,is_system,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)',[id,'',parent,code,en,zh,en,path,depth,type,sort,email,now,now]);
  await c.execute("INSERT INTO _lifewood_bootstrap VALUES ('0001',?)",[now]);
  const directory=join(homedir(),'Library','Application Support','Lifewood','MySQL');await mkdir(directory,{recursive:true,mode:0o700});
  const secret=join(directory,process.env.MYSQL_DATABASE==='lifewood_aigc_test'?'test-admin-initial.txt':'admin-initial.txt');
  const file=await open(secret,'wx',0o600);createdSecret=secret;try{await file.writeFile(`URL: http://localhost:3002\nEmail: ${email}\nInitial password: ${password}\nChange password at first login.\n`);await file.sync();}finally{await file.close();}
  await c.commit();createdSecret=undefined;console.log('Initialized one administrator and public folders. Credential file: '+secret);
 }
}catch(error){await c.rollback();if(createdSecret)await unlink(createdSecret);throw error;}finally{await c.end();}
