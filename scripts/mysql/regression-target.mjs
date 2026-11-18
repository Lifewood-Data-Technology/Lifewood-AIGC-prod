import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {auditResource} from '../../runtime/audit-environment.ts';

export function regressionTarget(values=process.env){
 if(values.LIFEWOOD_ENV==='audit'){
  const selected=auditResource(values),port=values.MYSQL_PORT||'3306';
  const resource=selected.resource;
  // A disposable run keeps its regression marker inside its own run directory (tests/isolated), removed with the run.
  const marker=selected.disposable?join(tmpdir(),'lifewood-isolated',values.LIFEWOOD_AUDIT_RUN,'regression-run.json'):join(tmpdir(),`lifewood-audit-${createHash('sha256').update(`${resource}:${port}`).digest('hex').slice(0,20)}.json`);
  return {database:selected.MYSQL_DATABASE,user:selected.MYSQL_USER,account:`${selected.MYSQL_USER}@${selected.accountHost}`,bucket:selected.WASABI_BUCKET,prefix:selected.WASABI_PREFIX,resource,shared:selected.shared,
   disposable:selected.disposable,offline:selected.offline,run:selected.disposable?values.LIFEWOOD_AUDIT_RUN:undefined,container:selected.disposable?values.LIFEWOOD_AUDIT_DISPOSABLE_MYSQL:undefined,
   marker,source:'synthetic-historical-regression-audit'};
 }
 if(values.LIFEWOOD_ENV!=='test')throw Error('Regression resource binding mismatch: requires test or audit');
 return {database:'lifewood_aigc_test',user:'lifewood_test',account:'lifewood_test@127.0.0.1',bucket:'aigc-dev',prefix:'lifewood-test/app/',resource:'lifewood_aigc_test:aigc-dev:lifewood-test/app/',marker:'/tmp/lifewood-mysql-active-run.json',source:'synthetic-historical-regression',disposable:false,offline:false};
}
export function assertRunMarker(marker,values=process.env){
 const target=regressionTarget(values);
 assert.equal(marker.database,target.database);assert.equal(marker.wasabiPrefix,target.prefix);assert.match(marker.run||'',/^[a-f0-9-]{36}$/);
 if(values.LIFEWOOD_ENV==='audit'){
  assert.equal(marker.resource,target.resource);assert.equal(marker.port,values.MYSQL_PORT||'3306');assert.equal(marker.bucket,target.bucket);
  if(target.disposable)assert.equal(marker.run,target.run,'RUN_MARKER_FOREIGN: disposable run id differs');
 }
 return target;
}
