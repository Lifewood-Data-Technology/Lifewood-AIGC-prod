import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {authenticate,signRpcResponse,RESPONSE_SIGNATURE_HEADER,RPC_PATH} from './protocol.mjs';
import {createSourceAuthorizer} from './source-authorization.mjs';
export {signRpc,authenticate,signRpcResponse,verifyRpcResponse,RESPONSE_SIGNATURE_HEADER,RPC_PATH} from './protocol.mjs';
import {HeadObjectCommand, CreateMultipartUploadCommand, CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand, GetObjectCommand, UploadPartCommand, ListPartsCommand} from '@aws-sdk/client-s3';

export const PART_BYTES = 8 * 1024 * 1024;
const fail = (code, status = 400) => Object.assign(new Error(code), {code, status});
const identity = x => typeof x === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(x);
const key = x => typeof x === 'string' && x.length > 0 && x.length <= 2048 && !x.startsWith('/') && !x.includes('\\') && !Array.from(x).some(c=>c.charCodeAt(0)<=31 || c.charCodeAt(0)===127) && !x.split('/').slice(0,-1).some(p=>p==='') && !x.split('/').some(p => p === '.' || p === '..');
const origin = value => {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/' || !/^s3(?:\.[a-z0-9-]+)?\.wasabisys\.com$/.test(u.hostname)) throw fail('INVALID_STORAGE_ENDPOINT');
  return u.origin;
};
export function loadConfig(env) {
  const required = name => {if (!env[name]) throw fail('MISSING_CONFIGURATION'); return env[name];};
  const config = {
    bucket: required('DESERET_RELAY_BUCKET'), endpoint: origin(required('DESERET_RELAY_ENDPOINT')), region: required('DESERET_RELAY_REGION'),
    accessKeyId: required('DESERET_RELAY_ACCESS_KEY_ID'), secretAccessKey: required('DESERET_RELAY_SECRET_ACCESS_KEY'),
    sourcePrefix: env.DESERET_RELAY_SOURCE_PREFIX || '',
    authOrigin:required('DESERET_RELAY_AUTH_ORIGIN'),authKeyId:required('DESERET_RELAY_AUTH_KEY_ID'),authSecret:required('DESERET_RELAY_AUTH_SECRET'), reviewPrefix: required('DESERET_RELAY_REVIEW_PREFIX'),
    aigcBucket: required('DESERET_RELAY_AIGC_BUCKET'), aigcEndpoint: origin(required('DESERET_RELAY_AIGC_ENDPOINT')),
    aigcPrefix: env.DESERET_RELAY_AIGC_PREFIX || '', keyId: required('DESERET_RELAY_KEY_ID'), secret: required('DESERET_RELAY_SECRET'),
  };
  if (!identity(config.keyId) || Buffer.byteLength(config.secret) < 32 || config.secret.length > 4096 ||
      ![config.bucket, config.aigcBucket].every(x => /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(x)) || config.bucket === config.aigcBucket ||
      ![config.sourcePrefix, config.reviewPrefix, config.aigcPrefix].every(x => x === '' || (key(x) && x.endsWith('/')))) throw fail('INVALID_CONFIGURATION');
  const prefixes=(list,fallback)=>{
    let values;try{values=list?JSON.parse(list):[fallback];}catch{throw fail('INVALID_CONFIGURATION');}
    if(!Array.isArray(values)||values.length<1||values.length>20||!values.every(x=>typeof x==='string'&&key(x)&&x.endsWith('/')))throw fail('INVALID_CONFIGURATION');return values;
  };
  config.sourcePrefixes=prefixes(env.DESERET_RELAY_SOURCE_PREFIXES,config.sourcePrefix);
  config.aigcReadPrefixes=prefixes(env.DESERET_RELAY_AIGC_READ_PREFIXES,config.aigcPrefix);
  config.aigcWritePrefixes=prefixes(env.DESERET_RELAY_AIGC_WRITE_PREFIXES,config.aigcPrefix);
  if(config.sourcePrefixes.some(x=>x.startsWith(config.reviewPrefix)||config.reviewPrefix.startsWith(x)))throw fail('INVALID_CONFIGURATION');
  const auth=new URL(config.authOrigin);
  if(auth.protocol!=='https:'||auth.username||auth.password||auth.pathname!=='/'||auth.search||auth.hash||!identity(config.authKeyId)||Buffer.byteLength(config.authSecret)<32||config.authSecret===config.secret)throw fail('INVALID_CONFIGURATION');
  config.authOrigin=auth.origin;
  config.storageProfileId=createHash('sha256').update(`${config.endpoint}/${config.bucket}/configuration-check|${config.region}`).digest('hex').toUpperCase();
  return config;
}
export function validateSignedUrl(value, config, objectKey, method, now = Date.now()) {
  if (typeof value !== 'string' || value.length > 16000 || !key(objectKey) || !(method==='GET'?config.aigcReadPrefixes:config.aigcWritePrefixes).some(prefix=>objectKey.startsWith(prefix))) throw fail('INVALID_CAPABILITY');
  const u = new URL(value), base = new URL(config.aigcEndpoint);
  const pathStyle = u.hostname === base.hostname && u.pathname.startsWith('/' + config.aigcBucket + '/');
  const virtualStyle = u.hostname === config.aigcBucket + '.' + base.hostname;
  if (u.protocol !== 'https:' || u.port || u.username || u.password || u.hash || (!pathStyle && !virtualStyle)) throw fail('INVALID_CAPABILITY');
  const encodedKey = pathStyle ? u.pathname.slice(config.aigcBucket.length + 2) : u.pathname.slice(1);
  if (decodeURIComponent(encodedKey) !== objectKey) throw fail('INVALID_CAPABILITY');
  const get = name => {if (u.searchParams.getAll(name).length !== 1) throw fail('INVALID_CAPABILITY'); return u.searchParams.get(name);};
  if (get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256' || !/^[a-f0-9]{64}$/.test(get('X-Amz-Signature')) || !get('X-Amz-Credential')) throw fail('INVALID_CAPABILITY');
  const expires = Number(get('X-Amz-Expires')), date = get('X-Amz-Date');
  if (!/^\d{8}T\d{6}Z$/.test(date) || !Number.isInteger(expires) || expires < 1 || expires > 300) throw fail('INVALID_CAPABILITY');
  const time = Date.parse(date.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));
  if (!Number.isFinite(time) || time > now + 300000 || time + expires * 1000 < now) throw fail('EXPIRED_CAPABILITY');
  const signed = get('X-Amz-SignedHeaders').split(';');
  if (method === 'GET' && (!signed.includes('range') || !signed.includes('if-match'))) throw fail('UNPINNED_CAPABILITY');
  if (method === 'PUT' && (!u.searchParams.get('uploadId') || !/^\d+$/.test(u.searchParams.get('partNumber') || ''))) throw fail('INVALID_CAPABILITY');
  return u.href;
}
async function boundedBytes(body, expected, signal) {
  const chunks = []; let length = 0;
  const abort = () => { body.destroy?.(new Error("Transfer cancelled")); body.cancel?.().catch(() => {}); };
  signal.throwIfAborted(); signal.addEventListener("abort", abort, {once:true});
  try {
    for await (const chunk of body) {
      signal.throwIfAborted(); length += chunk.length;
      if (length > expected) throw fail('SOURCE_SIZE_CHANGED', 409);
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {body.destroy?.(); await body.cancel?.().catch(() => {}); throw error;}
  finally {signal.removeEventListener("abort",abort);}
  if (length !== expected) throw fail('SOURCE_SIZE_CHANGED', 409);
  return Buffer.concat(chunks, length);
}
export function createExecutor(config, client, fetcher = fetch, authorize = createSourceAuthorizer(config)) {
  return async (job, signal) => {
    if (!job || typeof job !== 'object' || !['head','begin','complete','abort','part','list'].includes(job.op) || !key(job.key)) throw fail('INVALID_REQUEST');
    const review = job.key.startsWith(config.reviewPrefix), source = config.sourcePrefixes.some(prefix=>job.key.startsWith(prefix));
    if ((job.op === 'head' && !source && !review) || (['begin','complete','abort','list'].includes(job.op) && !review)) throw fail('OUTSIDE_SCOPE', 403);
    const input = {Bucket: config.bucket, Key: job.key};
    const send = command => client.send(command, {abortSignal: signal});
    const currentApprovedSource = async () => {
      const h = await send(new HeadObjectCommand({...input, ChecksumMode:'ENABLED'}));
      const file = job.source.file;
      const integrity = file.integrity ?? { algorithm: 'sha256', value: file.sha256 };
      const metadata = h.Metadata || {};
      const declared=metadata['lifewood-sha256'] || (metadata['lifewood-integrity-algorithm']==='sha256'?metadata['lifewood-integrity-value']:undefined);
      const checksum=h.ChecksumSHA256 && h.ChecksumType!=='COMPOSITE';
      if (!Number.isSafeInteger(file.size) || h.ContentLength !== file.size ||
          (job.versionId !== undefined && job.versionId !== h.VersionId) ||
          (job.op === 'part' && (job.totalSize !== file.size || job.etag !== h.ETag))) throw fail('SOURCE_SIZE_CHANGED', 409);
      if (integrity.algorithm !== 'sha256' || !/^[a-f0-9]{64}$/.test(integrity.value) ||
          (file.sha256 !== undefined && file.sha256 !== integrity.value) || (!checksum && !declared)) {
        throw fail('TRANSFER_INTEGRITY_UNAVAILABLE', 409);
      }
      if (checksum ? h.ChecksumSHA256 !== Buffer.from(integrity.value, 'hex').toString('base64') : declared !== integrity.value) {
        throw fail('SOURCE_SIZE_CHANGED', 409);
      }
      return h;
    };
    const upload = () => {
      if (typeof job.uploadId !== 'string' || !job.uploadId || job.uploadId.length > 4096 || Array.from(job.uploadId).some(c=>c.charCodeAt(0)<=32)) throw fail('INVALID_UPLOAD');
      return job.uploadId;
    };
    if((job.op==='head'&&job.direction==='deseret_to_aigc')||(job.op==='part'&&job.direction==='deseret_to_aigc')){
      if(!source)throw fail('OUTSIDE_SCOPE',403);
      if(!job.source||job.source.file?.objectKey!==job.key||job.source.file?.storageProfileId!==config.storageProfileId)throw fail('SOURCE_NOT_AUTHORIZED',403);
      await authorize(job.source,signal);
    }
    if (job.op === 'head') {
      if(job.direction!=='deseret_to_aigc' && (job.direction!=='aigc_to_deseret'||!review))throw fail('OUTSIDE_SCOPE',403);
      const h = job.direction==='deseret_to_aigc' ? await currentApprovedSource() : await send(new HeadObjectCommand({...input, ChecksumMode: 'ENABLED',VersionId:job.versionId||undefined}));
      return {ContentLength:h.ContentLength, ETag:h.ETag, VersionId:h.VersionId, ChecksumSHA256:h.ChecksumSHA256, ChecksumType:h.ChecksumType, Metadata:h.Metadata};
    }
    if (job.op === 'begin') {
      const m = job.metadata;
      if (!m || !['sha256','wasabi-sha256-parts-v1'].includes(m['lifewood-integrity-algorithm']) ||
          !['lifewood-integrity-value','lifewood-transfer'].every(k => /^[a-f0-9]{64}$/.test(m[k] || '')) ||
          Object.keys(m).length !== 3 || typeof job.mimeType !== 'string' || job.mimeType.length > 255 || /[\r\n]/.test(job.mimeType)) throw fail('INVALID_METADATA');
      const r = await send(new CreateMultipartUploadCommand({...input, ContentType:job.mimeType, Metadata:m})); return {UploadId:r.UploadId};
    }
    if (job.op === 'list') {
      if (job.marker !== undefined && !/^\d{1,5}$/.test(job.marker)) throw fail('INVALID_PART');
      const r = await send(new ListPartsCommand({...input, UploadId:upload(), PartNumberMarker:job.marker}));
      return {Parts:(r.Parts || []).map(p=>({PartNumber:p.PartNumber,ETag:p.ETag,Size:p.Size})),IsTruncated:r.IsTruncated,NextPartNumberMarker:r.NextPartNumberMarker};
    }
    if (job.op === 'abort') {await send(new AbortMultipartUploadCommand({...input, UploadId:upload()})); return {};}
    if (job.op === 'complete') {
      if (!Array.isArray(job.parts) || job.parts.length < 1 || job.parts.length > 10000 || !job.parts.every((p,i) => p.PartNumber === i+1 && typeof p.ETag === 'string' && /^"?[a-fA-F0-9-]{1,128}"?$/.test(p.ETag))) throw fail('INVALID_PARTS');
      const r = await send(new CompleteMultipartUploadCommand({...input, UploadId:upload(), IfNoneMatch:'*', MultipartUpload:{Parts:job.parts}}));return {ETag:r.ETag};
    }
    if (!['deseret_to_aigc','aigc_to_deseret'].includes(job.direction) || !Number.isSafeInteger(job.start) || job.start < 0 ||
        !Number.isSafeInteger(job.totalSize) || job.totalSize < 1 || !Number.isSafeInteger(job.end) || job.end >= job.totalSize || job.end < job.start || job.end - job.start + 1 > PART_BYTES ||
        typeof job.etag !== 'string' || !/^"[^"\r\n]{1,256}"$/.test(job.etag)) throw fail('INVALID_PART');
    const size = job.end - job.start + 1, range = `bytes=${job.start}-${job.end}`;
    if (job.direction === 'deseret_to_aigc') {
      if (!source) throw fail('OUTSIDE_SCOPE',403);
      await currentApprovedSource();
      const url = validateSignedUrl(job.url, config, job.peerKey, 'PUT');
      const r = await send(new GetObjectCommand({...input, Range:range, IfMatch:job.etag, VersionId:job.versionId || undefined}));
      if (r.ContentLength !== size || r.ContentRange !== `bytes ${job.start}-${job.end}/${job.totalSize}` || r.ETag !== job.etag) {r.Body?.destroy?.();throw fail('SOURCE_SIZE_CHANGED',409);}
      const bytes = await boundedBytes(r.Body,size,signal);
      await authorize(job.source,signal);
      await currentApprovedSource();
      const put = await fetcher(url,{method:'PUT',body:bytes,headers:{'Content-MD5':createHash('md5').update(bytes).digest('base64')},redirect:'error',signal});
      const etag = put.headers.get('etag');await put.body?.cancel();
      if (!put.ok || !etag) throw fail('PEER_UPLOAD_FAILED',502);
      if(etag.replaceAll('"','').toLowerCase()!==createHash('md5').update(bytes).digest('hex'))throw fail('PART_INTEGRITY_FAILED',409);
      return {CopyPartResult:{ETag:etag}};
    }
    if (!review || !Number.isInteger(job.partNumber) || job.partNumber < 1 || job.partNumber > 10000) throw fail('OUTSIDE_SCOPE',403);
    const uploadId = upload(), url = validateSignedUrl(job.url,config,job.peerKey,'GET');
    const get = await fetcher(url,{headers:{Range:range,'If-Match':job.etag},redirect:'error',signal});
    if(get.status!==206 && get.status!==200){
      await get.body?.cancel();
      if(get.status===404||get.status===412)throw fail('SOURCE_SIZE_CHANGED',409);
      if([400,401,403].includes(get.status))throw fail('INVALID_CAPABILITY',403);
      throw fail('PEER_READ_UNAVAILABLE',503);
    }
    if (get.status !== 206 || Number(get.headers.get('content-length')) !== size || get.headers.get('content-range') !== `bytes ${job.start}-${job.end}/${job.totalSize}` || get.headers.get('etag') !== job.etag) {await get.body?.cancel();throw fail('SOURCE_SIZE_CHANGED',409);}
    const bytes = await boundedBytes(get.body,size,signal);
    const r = await send(new UploadPartCommand({...input, UploadId:uploadId, PartNumber:job.partNumber, ContentLength:size, ContentMD5:createHash('md5').update(bytes).digest('base64'), Body:bytes}));
    if(r.ETag?.replaceAll('"','').toLowerCase()!==createHash('md5').update(bytes).digest('hex'))throw fail('PART_INTEGRITY_FAILED',409);
    return {CopyPartResult:{ETag:r.ETag}};
  };
}
export function createWorker(config, execute) {
  let active = 0, reading = 0;
  const replay = new Map();
  return createServer(async (req,res) => {
    // Responses to authenticated requests are signed for that request ID; pre-authentication rejections are not.
    let id;
    const send = (status,value) => {if (!res.destroyed) {const body=JSON.stringify(value);res.writeHead(status,{'content-type':'application/json','cache-control':'no-store',...(id?{[RESPONSE_SIGNATURE_HEADER]:signRpcResponse(body,config,id,status)}:{})});res.end(body);}};
    if (req.method !== 'POST' || req.url !== RPC_PATH) return send(404,{code:'NOT_FOUND'});
    if(req.headers['x-lw-key-id']!==config.keyId||!/^\d{1,12}$/.test(req.headers['x-lw-timestamp']||'')||Math.abs(Math.floor(Date.now()/1000)-Number(req.headers['x-lw-timestamp']))>300||!/^[a-f0-9]{64}$/.test(req.headers['x-lw-signature']||''))return send(401,{code:'UNAUTHORIZED'});
    if(reading>=8)return send(503,{code:'BUSY'});
    reading++;let admitted=false,readingBody=true;
    const controller = new AbortController(); const timer = setTimeout(()=>{controller.abort();if(readingBody)req.destroy();},115000);
    res.on('close',()=>{if(!res.writableEnded)controller.abort();});
    try {
      if (req.headers['content-type'] !== 'application/json') throw fail('INVALID_CONTENT_TYPE');
      const chunks=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>1024*1024)throw fail('REQUEST_TOO_LARGE',413);chunks.push(chunk);}
      const body=Buffer.concat(chunks);id=authenticate(req.headers,body,config);
      reading--;readingBody=false;if(active>=2)throw fail('BUSY',503);active++;admitted=true;
      for(const [k,expiry] of replay)if(expiry<Date.now())replay.delete(k);
      if(replay.has(id))throw fail('REPLAY',409);
      if(replay.size>=10000)throw fail('BUSY',503);
      replay.set(id,Date.now()+600000);
      let job;try{job=JSON.parse(body.toString('utf8'));}catch{throw fail('INVALID_REQUEST');}
      const result=await execute(job,controller.signal);
      send(200,{requestId:id,result});
    }catch(error){
      const status=error.status || error.$metadata?.httpStatusCode || 502;
      const known=['NoSuchUpload','NoSuchKey','NotFound','AccessDenied','PreconditionFailed'];
      const controlled=['INVALID_REQUEST','INVALID_CONTENT_TYPE','REQUEST_TOO_LARGE','UNAUTHORIZED','REPLAY','BUSY','OUTSIDE_SCOPE','INVALID_UPLOAD','INVALID_METADATA','INVALID_PARTS','INVALID_PART','INVALID_CAPABILITY','UNPINNED_CAPABILITY','EXPIRED_CAPABILITY','SOURCE_SIZE_CHANGED','PEER_UPLOAD_FAILED','PEER_READ_UNAVAILABLE','SOURCE_NOT_AUTHORIZED','AUTHORIZATION_UNAVAILABLE','AUTHORIZATION_NOT_CONFIGURED','PART_INTEGRITY_FAILED','TRANSFER_INTEGRITY_UNAVAILABLE'];
      const code=controlled.includes(error.code)?error.code:(known.includes(error.name)?error.name:'TRANSFER_FAILED');
      send([400,401,403,404,409,412,413,429,503].includes(status)?status:502,{code});
    }finally{clearTimeout(timer);if(admitted)active--;if(readingBody)reading--;}
  });
}
