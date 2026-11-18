import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';

export type PublicIngress = { origin: string; host: string; proxyToken: string };
type Incoming = { headers: IncomingHttpHeaders; rawHeaders?: string[]; url?: string; socket: { localAddress?: string; remoteAddress?: string } };
type Result = { url: string; clientIp: string } | { status: 400 | 403; message: string };
export const proxyTokenHeader = 'x-lifewood-proxy-token';

/** Opt-in single-hop TLS termination on the same host. Default local/LAN access stays unchanged. */
export function readPublicIngress(values: NodeJS.ProcessEnv = process.env): PublicIngress | null {
  const origin = values.LIFEWOOD_PUBLIC_ORIGIN, proxyToken = values.LIFEWOOD_PUBLIC_PROXY_TOKEN;
  if (origin === undefined && proxyToken === undefined) return null;
  if (!['production', 'test', 'audit'].includes(values.LIFEWOOD_ENV || '')) throw Error('Public ingress requires an explicit production, test or audit environment');
  if (Object.keys(values).some(key => key.startsWith('LIFEWOOD_LAN_') && values[key] !== undefined)) throw Error('Public ingress and direct LAN access cannot be combined');
  if (values.FILE_TRANSFER_MODE !== 'direct') throw Error('Public ingress requires direct file transfer');
  if (!origin || !proxyToken || !/^[A-Za-z0-9_-]{43,128}$/.test(proxyToken)) throw Error('Public ingress requires an HTTPS origin and private proxy token');
  let parsed: URL;
  try { parsed = new URL(origin); } catch { throw Error('Invalid public origin'); }
  if (parsed.protocol !== 'https:' || parsed.origin !== origin || parsed.username || parsed.password ||
      parsed.pathname !== '/' || parsed.search || parsed.hash || !parsed.hostname.includes('.') ||
      isIP(parsed.hostname) || parsed.hostname.startsWith('[') || parsed.hostname.endsWith('.') || parsed.hostname.endsWith('.localhost')) throw Error('Public origin must be one canonical HTTPS domain origin without a trailing slash');
  return { origin, host: parsed.host, proxyToken };
}

const loopback = (value?: string) => value === '127.0.0.1' || value === '::ffff:127.0.0.1';
const forbiddenProxyHeader = (key: string) => key === 'forwarded' || key.startsWith('x-forwarded-') && !['x-forwarded-for','x-forwarded-proto'].includes(key) || ['x-real-ip','cf-connecting-ip','true-client-ip'].includes(key);

/** Check transport before constructing the public Request. No caller-controlled host or proxy chain is trusted. */
export function publicRequestContext(request: Incoming, config: PublicIngress): Result {
  if (!loopback(request.socket.localAddress) || !loopback(request.socket.remoteAddress)) return { status: 403, message: 'Proxy transport required' };
  const critical = new Set(['host', proxyTokenHeader, 'x-forwarded-for', 'x-forwarded-proto']);
  const seen = new Set<string>();
  for (let i=0; i<(request.rawHeaders?.length || 0); i+=2) {
    const name = request.rawHeaders![i].toLowerCase();
    if (critical.has(name) && seen.has(name)) return { status: 400, message: 'Ambiguous proxy headers' };
    seen.add(name);
  }
  if (Object.keys(request.headers).some(key => forbiddenProxyHeader(key.toLowerCase()))) return { status: 400, message: 'Unsupported proxy headers' };
  const token = request.headers[proxyTokenHeader];
  if (typeof token !== 'string' || Buffer.byteLength(token) !== Buffer.byteLength(config.proxyToken) ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(config.proxyToken))) return { status: 403, message: 'Proxy authentication required' };
  if (request.headers.host !== config.host || request.headers['x-forwarded-proto'] !== 'https') return { status: 400, message: 'Invalid public origin' };
  const clientIp = request.headers['x-forwarded-for'];
  if (typeof clientIp !== 'string' || clientIp.includes('%') || !isIP(clientIp)) return { status: 400, message: 'One verified client address is required' };
  const target = request.url || '/';
  if (!target.startsWith('/') || target.startsWith('//') || /[\\#\s]/.test(target) || Array.from(target).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) || /%(?![a-fA-F0-9]{2})/.test(target)) return { status: 400, message: 'Invalid request target' };
  const url = new URL(config.origin + target);
  if (url.origin !== config.origin || url.pathname + url.search !== target) return { status: 400, message: 'Non-canonical request target' };
  return { url: url.href, clientIp };
}

/** Internal handlers receive verified URL/IP from the runtime, never proxy secrets or raw forwarding claims. */
export function removeProxyHeaders(headers: Headers) {
  for (const name of [...headers.keys()]) if (name === proxyTokenHeader || name === 'forwarded' || name.startsWith('x-forwarded-') || ['x-real-ip','cf-connecting-ip','true-client-ip'].includes(name)) headers.delete(name);
}
