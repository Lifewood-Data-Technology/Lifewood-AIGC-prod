/** An explicitly bound, disposable audit target. Existing local/Test/production identities stay fixed. */
const RUN_UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const ISOLATED_OFFLINE_BUCKET='lifewood-isolated-offline';
export function auditResource(values:NodeJS.ProcessEnv) {
  const database='lifewood_aigc_audit',user='lifewood_audit';
  const bucket=values.WASABI_BUCKET||'';
  const shared=values.LIFEWOOD_AUDIT_SHARED_BUCKET!==undefined;
  // A per-run disposable MySQL container (tests/isolated). Bound to the full container id and a UUID run.
  const disposable=values.LIFEWOOD_AUDIT_DISPOSABLE_MYSQL!==undefined;
  if(disposable){
    if(!/^[a-f0-9]{64}$/.test(values.LIFEWOOD_AUDIT_DISPOSABLE_MYSQL||''))throw Error('Audit disposable MySQL binding must be the full container id');
    if(!RUN_UUID.test(values.LIFEWOOD_AUDIT_RUN||''))throw Error('Audit disposable MySQL requires a UUID run');
  }
  // Offline storage: a clearly fake bucket for an egress-blocked server. Never reaches any real bucket.
  const offline=values.LIFEWOOD_ISOLATED_STORAGE!==undefined||bucket===ISOLATED_OFFLINE_BUCKET;
  if(offline&&(values.LIFEWOOD_ISOLATED_STORAGE!=='offline'||bucket!==ISOLATED_OFFLINE_BUCKET||!disposable||shared))throw Error('Isolated offline storage requires the offline bucket and a disposable MySQL binding');
  let prefix='lifewood-audit/app/';
  if(shared){
    // Explicitly authorized local bucket reuse. Never accept the business prefix.
    if(bucket!=='local-aigc'||values.LIFEWOOD_AUDIT_SHARED_BUCKET!==bucket)throw Error('Audit shared bucket must be local-aigc');
    if(!RUN_UUID.test(values.LIFEWOOD_AUDIT_RUN||''))throw Error('Audit shared bucket requires a UUID run');
    prefix=`lifewood-audit/runs/${values.LIFEWOOD_AUDIT_RUN}/`;
  }else if(!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)||['aigc','aigc-dev','local-aigc'].includes(bucket))throw Error('Audit requires a separate Wasabi bucket or explicit shared local run');
  else if(disposable)prefix=`lifewood-audit/runs/${values.LIFEWOOD_AUDIT_RUN}/`;
  const resource=`${database}:${bucket}:${prefix}`;
  if(values.LIFEWOOD_AUDIT_RESOURCE!==resource)throw Error('Explicit audit resource binding required');
  // Docker's loopback published port authenticates from its private bridge.
  const accountHost=values.LIFEWOOD_AUDIT_MYSQL_ACCOUNT_HOST||'127.0.0.1';
  if(accountHost!=='127.0.0.1'&&(!(shared||disposable)||!/^172\.(1[6-9]|2\d|3[01])\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.test(accountHost)||accountHost.split('.').some(n=>Number(n)>255)))throw Error('Audit requires an exact local container account host');
  return {MYSQL_DATABASE:database,MYSQL_USER:user,WASABI_BUCKET:bucket,WASABI_PREFIX:prefix,resource,shared,disposable,offline,accountHost};
}
