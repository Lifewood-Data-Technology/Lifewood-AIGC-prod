import {timingSafeEqual} from 'node:crypto';
import {isIPv4} from 'node:net';
import type {IncomingHttpHeaders} from 'node:http';
import {auditResource} from './audit-environment';
import {readLanAccess, rejectDirectRequest, type LanAccess} from './lan-access';

export type TrustedProxy = {origins:string[]; token:string; access:LanAccess};
type ProxyRequest = {url?:string; headers:IncomingHttpHeaders; rawHeaders?:string[]; socket:{localAddress?:string;remoteAddress?:string}};
type ProxyContext = {url:string;clientIp:string;rejection?:never} | {rejection:{status:400|403;message:string};url?:never;clientIp?:never};
const keys=['LIFEWOOD_PROXY_ORIGINS','LIFEWOOD_PROXY_CIDRS','LIFEWOOD_PROXY_TOKEN'] as const;

/** Explicit single-hop Test or disposable audit proxy. A selected private env owns all three values. */
export function readTrustedProxy(values:NodeJS.ProcessEnv=process.env):TrustedProxy|null {
  if(keys.every(key=>values[key]===undefined))return null;
  if(!['test','audit'].includes(values.LIFEWOOD_ENV||'')||keys.some(key=>!values[key]))throw Error('Complete Test or isolated audit proxy configuration is required');
  if(values.LIFEWOOD_ENV==='audit'&&!auditResource(values).disposable)throw Error('Proxy audit requires a disposable resource binding');
  if(Object.keys(values).some(key=>key.startsWith('LIFEWOOD_LAN_')))throw Error('Proxy and direct LAN configuration cannot be combined');
  const token=values.LIFEWOOD_PROXY_TOKEN!;
  if(!/^[a-f0-9]{64}$/.test(token))throw Error('Invalid proxy credential configuration');
  const origins=values.LIFEWOOD_PROXY_ORIGINS!.split(',');
  if(!origins.length||origins.length>9||new Set(origins).size!==origins.length)throw Error('Invalid proxy origins');
  for(const origin of origins){
    const url=new URL(origin);
    if(url.origin!==origin||url.protocol!=='https:'||!isIPv4(url.hostname))throw Error('Proxy origins require exact HTTPS IPv4 origins');
    readLanAccess({NODE_ENV:'production',LIFEWOOD_ENV:'test',LIFEWOOD_LAN_HOST:url.hostname,LIFEWOOD_LAN_CIDRS:values.LIFEWOOD_PROXY_CIDRS});
  }
  const access=readLanAccess({NODE_ENV:'production',LIFEWOOD_ENV:'test',LIFEWOOD_LAN_HOST:new URL(origins[0]).hostname,LIFEWOOD_LAN_CIDRS:values.LIFEWOOD_PROXY_CIDRS})!;
  return {origins,token,access};
}

/** Resolve before nodeToWebRequest, and remove every untrusted identity hint. */
export function trustedProxyRequest(request:ProxyRequest,port:number,config:TrustedProxy):ProxyContext {
  const deny=(status:400|403,message:string):ProxyContext=>({rejection:{status,message}});
  const normalize=(value?:string)=>value?.replace(/^::ffff:/,'');
  if(normalize(request.socket.localAddress)!=='127.0.0.1'||normalize(request.socket.remoteAddress)!=='127.0.0.1')return deny(403,'Untrusted proxy connection');
  const target=request.url||'/';
  if(!target.startsWith('/')||target.startsWith('//')||/[\\#]/.test(target)||Array.from(target).some(character=>character.charCodeAt(0)<=32||character.charCodeAt(0)===127))return deny(400,'Invalid request target');
  const required=['host','x-forwarded-for','x-forwarded-host','x-forwarded-proto','x-lifewood-proxy-token'];
  for(const name of required){
    if(typeof request.headers[name]!=='string')return deny(400,'Invalid proxy metadata');
    const occurrences=(request.rawHeaders||[]).filter((header,index)=>index%2===0&&header.toLowerCase()===name).length;
    if(occurrences>1)return deny(400,'Duplicate proxy metadata');
  }
  if(request.headers.host!==`127.0.0.1:${port}`)return deny(400,'Invalid upstream host');
  const supplied=request.headers['x-lifewood-proxy-token'] as string;
  if(!/^[a-f0-9]{64}$/.test(supplied)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(config.token)))return deny(403,'Untrusted proxy credential');
  const clientIp=request.headers['x-forwarded-for'] as string;
  const suppliedOrigin=`${request.headers['x-forwarded-proto']}://${request.headers['x-forwarded-host']}`;
  const origin=config.origins.find(candidate=>candidate===suppliedOrigin);
  if(!isIPv4(clientIp)||!origin)return deny(400,'Invalid proxy origin or client address');
  // Reuse the direct listener's established private CIDR policy.
  const rejection=rejectDirectRequest({url:target,headers:{host:`${config.access.host}:${port}`},socket:{localAddress:config.access.host,remoteAddress:clientIp}},port,config.access);
  if(rejection)return {rejection};
  for(const name of Object.keys(request.headers)){
    if(name==='forwarded'||name.startsWith('x-forwarded-')||name.startsWith('x-lifewood-proxy-')||['x-real-ip','cf-connecting-ip','true-client-ip','x-lifewood-client-ip'].includes(name))delete request.headers[name];
  }
  return {url:origin+target,clientIp};
}
