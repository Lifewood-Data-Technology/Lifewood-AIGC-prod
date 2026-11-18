import { X509Certificate, createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createSecureContext } from 'node:tls';
import type { ServerOptions } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { LanAccess } from './lan-access';

/** TLS is an explicit extension of the existing direct Test LAN listener. */
export function readLanTls(lan: LanAccess | null, values: NodeJS.ProcessEnv = process.env): ServerOptions | undefined {
    const certPath = values.LIFEWOOD_LAN_TLS_CERT;
    const keyPath = values.LIFEWOOD_LAN_TLS_KEY;
    if (certPath === undefined && keyPath === undefined) {
        if (lan?.aliases.length) throw Error('LAN aliases require explicit TLS certificate and key');
        return undefined;
    }
    if (!lan || values.LIFEWOOD_ENV !== 'test') throw Error('LAN TLS requires explicit Test LAN access');
    if (!certPath || !keyPath || !isAbsolute(certPath) || !isAbsolute(keyPath)) {
        throw Error('LAN TLS requires absolute certificate and key paths');
    }
    try {
        const cert = readFileSync(certPath);
        const key = readFileSync(keyPath);
        const certificate = new X509Certificate(cert);
        const now = Date.now();
        if (certificate.ca || ![lan.host, ...lan.aliases].every(host => certificate.checkIP(host)) ||
            !(Date.parse(certificate.validFrom) <= now && now < Date.parse(certificate.validTo)) ||
            !certificate.checkPrivateKey(createPrivateKey(key))) throw Error('Invalid certificate');
        const options: ServerOptions = { cert, key, minVersion: 'TLSv1.2' };
        createSecureContext(options);
        return options;
    } catch {
        // Crypto/parser errors must not echo file contents or key material.
        throw Error('Invalid LAN TLS certificate or key; check IP, dates and key pairing');
    }
}

/** Call only after rejectDirectRequest has validated Host, target and socket addresses. */
export function directLanRequestUrl(request: IncomingMessage, lan: LanAccess | null, tlsEnabled: boolean): string | undefined {
    if (!lan) return undefined; // Preserve the existing default loopback transport.
    const encrypted = 'encrypted' in request.socket && request.socket.encrypted === true;
    const localAddress = request.socket.localAddress?.replace(/^::ffff:/, '');
    if (tlsEnabled && localAddress === lan.host && !encrypted) throw Error('LAN TLS transport required');
    return `${encrypted ? 'https' : 'http'}://${request.headers.host}${request.url || '/'}`;
}
