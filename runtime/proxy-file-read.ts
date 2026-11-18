import type { WasabiBucket } from './wasabi';
import { fileResponsePolicy } from '../lib/request-security.ts';
import { PublicError } from '../lib/security-controls.ts';

export type HttpObjectRead =
    | { status: 416; totalSize: number }
    | { status: 200 | 206; totalSize: number; size: number; body: ReadableStream<Uint8Array>; etag: string; contentType?: string; contentRange?: string };

import { requestedByteRange } from '../lib/http-byte-range.ts';

type ReadBucket = Pick<WasabiBucket, 'head' | 'get'> & Partial<Pick<WasabiBucket, 'readHttpRange'>>;

/** Called only after the owning business route authorizes the current request. */
export async function proxyFileResponse(bucket: ReadBucket, key: string, name: string, download: boolean,
    rangeHeader: string | null, contentType?: string, cacheControl = 'private, no-store') {
    const started = performance.now();
    let read: HttpObjectRead | null;
    if (bucket.readHttpRange) read = await bucket.readHttpRange(key, rangeHeader);
    else {
        // Retain the bucket contract used by legacy adapters and synthetic fixtures.
        const head = await bucket.head(key);
        if (!head) throw new PublicError('Stored file was not found.');
        const range = requestedByteRange(rangeHeader, head.size);
        if (range?.invalid) read = { status: 416, totalSize: head.size };
        else {
            const object = await bucket.get(key, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined);
            const metadata = new Headers(); object?.writeHttpMetadata(metadata);
            read = object ? { status: range ? 206 : 200, totalSize: head.size, size: range ? range.end - range.start + 1 : head.size,
                body: object.body, etag: object.httpEtag, contentType: metadata.get('content-type') ?? undefined,
                ...(range ? { contentRange: `bytes ${range.start}-${range.end}/${head.size}` } : {}) } : null;
        }
    }
    if (!read) throw new PublicError('Stored file was not found.');
    if (read.status === 416) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${read.totalSize}`, 'accept-ranges': 'bytes' } });
    const policy = fileResponsePolicy(contentType || read.contentType || 'application/octet-stream', download);
    const headers = new Headers({ 'content-type': policy.contentType, 'x-content-type-options': 'nosniff',
        'content-security-policy': policy.csp, 'referrer-policy': 'no-referrer', etag: read.etag,
        'cache-control': cacheControl, 'accept-ranges': 'bytes', 'content-length': String(read.size),
        'server-timing': `storage;dur=${(performance.now() - started).toFixed(1)}`,
        'content-disposition': `${policy.disposition}; filename*=UTF-8''${encodeURIComponent(name)}` });
    if (read.contentRange) headers.set('content-range', read.contentRange);
    return new Response(read.body, { status: read.status, headers });
}
