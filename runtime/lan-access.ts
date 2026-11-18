import { createServer, type IncomingHttpHeaders, type RequestListener, type Server } from 'node:http';
import { isIPv4 } from 'node:net';
import { createServer as createHttpsServer, type ServerOptions } from 'node:https';

type Ipv4Range = { network: number; mask: number };
export type LanAccess = { host: string; aliases: string[]; cidrs: string[]; ranges: Ipv4Range[] };
type DirectRequest = {
    headers: IncomingHttpHeaders;
    url?: string;
    socket: { localAddress?: string; remoteAddress?: string };
};
type RequestRejection = { status: 400 | 403; message: string };

function ipv4Number(address: string): number | null {
    if (!isIPv4(address)) return null;
    return address.split('.').reduce((value, octet) => (value * 256) + Number(octet), 0);
}

function inRange(address: number, range: Ipv4Range) {
    return ((address & range.mask) >>> 0) === range.network;
}

const privateRanges: Ipv4Range[] = [
    { network: 0x0a000000, mask: 0xff000000 },
    { network: 0xac100000, mask: 0xfff00000 },
    { network: 0xc0a80000, mask: 0xffff0000 },
];

function privateAddress(address: number) {
    return privateRanges.some(range => inRange(address, range));
}

function parsePrivateCidr(cidr: string): Ipv4Range {
    const match = /^([^/]+)\/(0|[1-9]\d?)$/.exec(cidr);
    const network = match ? ipv4Number(match[1]) : null;
    const prefix = match ? Number(match[2]) : -1;
    if (network === null || prefix < 0 || prefix > 32) throw Error('Invalid LIFEWOOD_LAN_CIDRS');
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const range = { network, mask };
    const last = (network | (~mask >>> 0)) >>> 0;
    if (!inRange(network, range) || !privateRanges.some(allowed => inRange(network, allowed) && inRange(last, allowed))) {
        throw Error('LIFEWOOD_LAN_CIDRS must contain canonical private IPv4 networks');
    }
    return range;
}

/** LAN access is an explicit Test opt-in; unset values retain the existing loopback-only service. */
export function readLanAccess(values: NodeJS.ProcessEnv = process.env): LanAccess | null {
    const host = values.LIFEWOOD_LAN_HOST;
    const rawCidrs = values.LIFEWOOD_LAN_CIDRS;
    const rawAliases = values.LIFEWOOD_LAN_ALIASES;
    if (host === undefined && rawCidrs === undefined && rawAliases === undefined) return null;
    if (values.LIFEWOOD_ENV !== 'test') throw Error('LAN HTTP access is only supported for Test');
    const address = host === undefined ? null : ipv4Number(host);
    if (address === null || !privateAddress(address)) throw Error('LIFEWOOD_LAN_HOST must be one private IPv4 address');
    if (!rawCidrs) throw Error('LIFEWOOD_LAN_CIDRS is required for LAN access');
    const cidrs = rawCidrs.split(',').map(cidr => cidr.trim());
    if (cidrs.length > 32) throw Error('Too many LIFEWOOD_LAN_CIDRS');
    const ranges = cidrs.map(parsePrivateCidr);
    if (!ranges.some(range => inRange(address, range))) throw Error('LIFEWOOD_LAN_HOST must be inside an allowed LAN network');
    const aliases = rawAliases === undefined ? [] : rawAliases.split(',').map(alias => alias.trim());
    if (aliases.length > 8 || new Set([host, ...aliases]).size !== aliases.length + 1 || aliases.some(alias => {
        const value = ipv4Number(alias);
        return value === null || !privateAddress(value);
    })) throw Error('LIFEWOOD_LAN_ALIASES must contain at most eight distinct private IPv4 addresses other than the listener');
    return { host: host!, aliases, cidrs, ranges };
}

function normalizedAddress(address: string | undefined) {
    return address?.startsWith('::ffff:') ? address.slice(7) : address;
}

/** Explicit aliases support L4 address translation, never trusted forwarding headers or extra binds. */
export function rejectDirectRequest(request: DirectRequest, port: number, lanAccess: LanAccess | null): RequestRejection | null {
    if (!lanAccess) {
        return [`localhost:${port}`, `127.0.0.1:${port}`].includes(request.headers.host || '')
            ? null
            : { status: 400, message: 'Invalid host' };
    }
    for (const header of Object.keys(request.headers)) {
        const name = header.toLowerCase();
        if (name === 'forwarded' || name.startsWith('x-forwarded-') || ['x-real-ip', 'cf-connecting-ip', 'true-client-ip'].includes(name)) {
            return { status: 400, message: 'Forwarded headers are not accepted' };
        }
    }
    // nodeToWebRequest accepts absolute URLs. Reject them before they can replace the checked Host.
    const target = request.url || '/';
    if (!target.startsWith('/') || target.startsWith('//') || /[\\#]/.test(target) || Array.from(target).some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)) {
        return { status: 400, message: 'Invalid request target' };
    }
    const localAddress = normalizedAddress(request.socket.localAddress);
    const remoteAddress = normalizedAddress(request.socket.remoteAddress);
    if (localAddress === '127.0.0.1') {
        if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(request.headers.host || '')) {
            return { status: 400, message: 'Invalid host' };
        }
        if (remoteAddress !== '127.0.0.1') return { status: 403, message: 'Client address is not allowed' };
        return null;
    }
    if (localAddress !== lanAccess.host) return { status: 403, message: 'Listener address is not allowed' };
    if (![lanAccess.host, ...lanAccess.aliases].some(host => request.headers.host === `${host}:${port}`)) {
        return { status: 400, message: 'Invalid host' };
    }
    const address = remoteAddress === undefined ? null : ipv4Number(remoteAddress);
    if (address === null || !lanAccess.ranges.some(range => inRange(address, range))) {
        return { status: 403, message: 'Client address is not allowed' };
    }
    return null;
}

export async function closeHttpListeners(servers: Server[], force = false) {
    await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => {
        server.close(error => {
            if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
            else resolve();
        });
        if (force) server.closeAllConnections();
    })));
}

/** Bind only the validated addresses. A partial startup closes only servers created by this call. */
export async function listenHttpAddresses(listener: RequestListener, port: number, addresses: string[], tls?: { host: string; options: ServerOptions }): Promise<Server[]> {
    const servers: Server[] = [];
    try {
        for (const host of addresses) {
            const server = tls?.host === host ? createHttpsServer(tls.options, listener) : createServer(listener);
            servers.push(server);
            await new Promise<void>((resolve, reject) => {
                const failed = (error: Error) => { reject(error); };
                server.once('error', failed);
                server.listen(port, host, () => {
                    server.off('error', failed);
                    resolve();
                });
            });
        }
        return servers;
    } catch (error) {
        await closeHttpListeners(servers, true);
        throw error;
    }
}
