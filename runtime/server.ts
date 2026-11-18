import { loadEnvironment } from '../scripts/mysql/environment.mjs';
import type { RequestListener } from 'node:http';
import { resolve } from 'node:path';
import { HTMLRewriter } from '@worker-tools/html-rewriter/base64';
import { importServerEntryModule, nodeToWebRequest, sendWebResponse, tryServeStatic } from 'vinext/server/prod-server';
import { authenticatedResponse } from '../lib/server-auth';
import { secureResponse } from '../lib/response-security';
import { env, shutdown, waitUntil } from './node-environment';
import { closeHttpListeners, listenHttpAddresses, readLanAccess, rejectDirectRequest } from './lan-access';
import { directLanRequestUrl, readLanTls } from './lan-tls';
import { businessLifecycleResponse } from './business-lifecycle-request';
import { sendOpenResponse } from './http-response';
import { directUploadService } from '../db/direct-upload';
import {createUploadFinalizer} from '../db/direct-upload-finalizer';
import { browserVideoGuard } from './browser-video-guard';
import { startDeseretIntegrationMaintenance } from './deseret-integration-maintenance';
import { readPublicIngress, publicRequestContext, removeProxyHeaders } from './public-ingress';
import {readTrustedProxy,trustedProxyRequest} from './trusted-proxy';
loadEnvironment();
const trustedProxy=readTrustedProxy();
const publicIngress = readPublicIngress();
if (publicIngress && trustedProxy) throw Error('Public and Test proxy modes cannot be combined');
const lanAccess = readLanAccess();
const lanTls = readLanTls(lanAccess);
Object.assign(globalThis, { HTMLRewriter });
const app = await importServerEntryModule(resolve('dist-mysql/server/index.js'));
const fetchHandler = typeof app.default === 'function' ? app.default : app.default?.fetch ?? app.fetch;
if (typeof fetchHandler !== 'function')
    throw Error('Missing Node app entry');
const port = Number(process.env.PORT || 3002);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw Error('Invalid local port');
const handleRequest: RequestListener = async (req, res) => {
    try {
        const proxyContext=trustedProxy?trustedProxyRequest(req,port,trustedProxy):null;
        const publicContext = publicIngress ? publicRequestContext(req, publicIngress) : null;
        const rejection = publicContext && 'status' in publicContext ? publicContext : publicIngress ? null : proxyContext?.rejection || (trustedProxy ? null : rejectDirectRequest(req, port, lanAccess));
        if (rejection) {
            res.writeHead(rejection.status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
            res.end(rejection.message);
            return;
        }
        const verifiedPublic = publicContext && 'url' in publicContext ? publicContext : null;
        const request = nodeToWebRequest(req, verifiedPublic?.url ?? proxyContext?.url ?? directLanRequestUrl(req, lanAccess, !!lanTls));
        if (verifiedPublic) removeProxyHeaders(request.headers);
        const pathname = new URL(request.url).pathname;
        // Browser-worker URLs are capabilities, never an application file/proxy route.
        const browserVideoRejection=browserVideoGuard(pathname);
        if (browserVideoRejection) { await sendOpenResponse(browserVideoRejection,req,res,sendWebResponse); return; }
        // Static assets contain no authenticated data. Do not serve arbitrary build files.
        if (!pathname.startsWith('/api/') && await tryServeStatic(req, res, resolve('dist-mysql/client'), pathname, true, undefined, { 'x-content-type-options': 'nosniff' }))
            return;
        const response = await authenticatedResponse(request, env.DB, verifiedPublic?.clientIp ?? proxyContext?.clientIp ?? req.socket.remoteAddress ?? '127.0.0.1', r => businessLifecycleResponse(r, env.DB, fetchHandler));
        await sendOpenResponse(secureResponse(response, request), req, res, sendWebResponse);
    }
    catch (error) {
        console.error('Local request failure', { name: error instanceof Error ? error.name : 'Unknown', code: (error as {
                code?: string;
            }).code || 'UNCLASSIFIED' });
        if (res.destroyed || res.closed || res.writableEnded) return;
        if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
            res.end(JSON.stringify({ error: 'Local request failed.' }));
        }
        else
            res.destroy();
    }
};
const servers = await listenHttpAddresses(handleRequest, port, lanAccess ? ['127.0.0.1', lanAccess.host] : ['127.0.0.1'], lanAccess && lanTls ? { host: lanAccess.host, options: lanTls } : undefined);
console.log(`Lifewood MySQL + Wasabi: http://localhost:${port}`);
console.log(`Lifewood storage: ${process.env.LIFEWOOD_ENV} ${process.env.WASABI_BUCKET}/${process.env.WASABI_PREFIX}`);
if (lanAccess) console.log(`Lifewood Test LAN: ${lanTls ? 'https' : 'http'}://${lanAccess.host}:${port}`);
let directCleanupRunning=false;
const finalizeUploads=createUploadFinalizer(env.DB,directUploadService());
const directCleanup = setInterval(()=>{
    if(directCleanupRunning)return;
    directCleanupRunning=true;
    waitUntil((async()=>{if(process.env.FILE_TRANSFER_MODE==='direct')await finalizeUploads();await directUploadService().cleanup();})().finally(()=>{directCleanupRunning=false;}));
},60000);
directCleanup?.unref();
const stopDeseretIntegration = startDeseretIntegrationMaintenance();
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => {
        if (closing) return;
        closing = true;
        clearInterval(directCleanup);
        stopDeseretIntegration();
        void closeHttpListeners(servers).then(() => shutdown()).then(() => process.exit(0)).catch(() => process.exit(1));
    });
