import { validateEnvironment } from './environment.ts';
import { S3Client, HeadObjectCommand, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, GetBucketVersioningCommand, ListMultipartUploadsCommand, ListObjectVersionsCommand, CreateMultipartUploadCommand, UploadPartCommand, UploadPartCopyCommand, ListPartsCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand, CopyObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { readUploadSettings } from '../lib/upload-settings.ts';
import { verifiedUpload } from './verified-upload.ts';
import { requestedByteRange } from '../lib/http-byte-range.ts';
import type { HttpObjectRead } from './proxy-file-read.ts';
import {installStorageDiagnostics} from './storage-diagnostics.ts';
import { wasabiAgentOptions } from './wasabi-proxy.ts';
/** Direct transfers support a bucket without versioning, or one with versioning Enabled. Suspended is refused. */
export type DirectStorageMode = 'unversioned' | 'enabled';
export type StoredObjectVersion = { versionId: string; deleteMarker: boolean };
export const validVersionId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1024 && value !== 'null' && !value.includes('\0');
export class WasabiBucket {
    private readonly client: S3Client;
    private readonly bucket: string;
    private readonly prefix: string;
    private readonly preventOverwrite: boolean;
    private readonly storageTimeoutMs: number;
    private directMode?: { at: number; value: Promise<DirectStorageMode> };
    constructor(env: NodeJS.ProcessEnv = process.env) {
        validateEnvironment(env);
        const required = (key: string) => { if (!env[key])
            throw Error(`${key} is required`); return env[key]!; };
        this.preventOverwrite = ['test','audit'].includes(env.LIFEWOOD_ENV||'');
        const limits = readUploadSettings(env);
        this.storageTimeoutMs = limits.storageTimeoutMs;
        this.bucket = required('WASABI_BUCKET');
        this.prefix = required('WASABI_PREFIX');
        const endpoint = new URL(required('WASABI_ENDPOINT'));
        this.client = new S3Client({ region: env.WASABI_REGION, endpoint: endpoint.href, credentials: { accessKeyId: required('WASABI_ACCESS_KEY_ID'), secretAccessKey: required('WASABI_SECRET_ACCESS_KEY') }, maxAttempts: 1,
            requestHandler: { ...wasabiAgentOptions(env.WASABI_HTTP_PROXY), connectionTimeout: limits.connectionTimeoutMs, socketTimeout: limits.socketTimeoutMs, throwOnRequestTimeout: true } });
        installStorageDiagnostics(this.client, 'application');
    }
    private key(key: string) { if (!key || key.startsWith('/') || key.split('/').some(s => s === '..') || key.includes('\0'))
        throw Error('Invalid object key'); return this.prefix + key; }
    private missing(error: unknown) { return (error as {
        $metadata?: {
            httpStatusCode?: number;
        };
    }).$metadata?.httpStatusCode === 404; }
    /** Without a versionId this reads the current version; with one, exactly that version (null when it is gone). */
    async head(key: string, options?: {checksum?: boolean; versionId?: string}) {
        if (options?.versionId !== undefined && !validVersionId(options.versionId)) throw Error('Invalid object version');
        try {
        const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(key), ...(options?.versionId?{VersionId:options.versionId}:{}), ...(options?.checksum?{ChecksumMode:'ENABLED' as const}:{}) }), { abortSignal: AbortSignal.timeout(15_000) });
        return { size: r.ContentLength ?? 0, etag: r.ETag?.replaceAll('"', '') ?? '', ...(r.Metadata?.['lifewood-upload-session']?{uploadOwner:r.Metadata['lifewood-upload-session']}:{}),
            ...(r.VersionId?{versionId:r.VersionId}:{}),
            ...(r.ChecksumSHA256?{checksumSha256:r.ChecksumSHA256}:{}), ...(r.ChecksumType?{checksumType:r.ChecksumType}:{}) };
    }
    catch (error) {
        if (this.missing(error))
            return null;
        throw error;
    } }
    async put(key: string, value: Blob | ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>, options?: {
        httpMetadata?: {
            contentType?: string;
        };
        customMetadata?: Record<string, string>;
    }) {
        const source = verifiedUpload(value);
        if (source) return source.promote?source.promote(key,options?.httpMetadata?.contentType):this.copy(source.key, key, source.etag, options?.httpMetadata?.contentType);
        const bytes = value instanceof ReadableStream ? new Uint8Array(await new Response(value).arrayBuffer()) : value instanceof Blob ? new Uint8Array(await value.arrayBuffer()) : value instanceof ArrayBuffer ? new Uint8Array(value) : value;
        // File names, checksums and ownership remain authoritative in MySQL.
        // Accept legacy call-site metadata without duplicating it into S3 headers,
        // whose ASCII/size limits must not restrict valid business file names.
        const r = await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.key(key), Body: bytes, ...(this.preventOverwrite ? {IfNoneMatch: '*'} : {}), ContentLength: bytes.byteLength, ContentType: options?.httpMetadata?.contentType }), { abortSignal: AbortSignal.timeout(this.storageTimeoutMs) });
        return { etag: r.ETag?.replaceAll('"', '') ?? '' };
    }
    async get(key: string, options?: {
        range?: {
            offset: number;
            length: number;
        };
    }) {
        const range = options?.range;
        if (range && (!Number.isSafeInteger(range.offset) || !Number.isSafeInteger(range.length) || range.offset < 0 || range.length <= 0))
            throw Error('Invalid byte range');
        try {
            const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(key), ...(range ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : {}) }));
            if (!r.Body)
                throw Error('Object body missing');
            const body = r.Body;
            return { body: body.transformToWebStream(), size: r.ContentLength ?? 0, httpEtag: r.ETag ?? '', writeHttpMetadata(headers: Headers) { if (r.ContentType)
                    headers.set('content-type', r.ContentType); }, async arrayBuffer() { return new Response(this.body).arrayBuffer(); } };
        }
        catch (error) {
            if (this.missing(error))
                return null;
            throw error;
        }
    }
    async delete(key: string) { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(key) })); }
    /** Permanently removes one exact version. Never a key-level delete, so no delete marker is written. */
    async deleteVersion(key: string, versionId: string) {
        if (!validVersionId(versionId)) throw Error('Invalid object version');
        await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(key), VersionId: versionId }), { abortSignal: AbortSignal.timeout(15_000) });
    }
    /** Versions and delete markers of exactly this key, for ownership checks. Lookup only; it never deletes. */
    async listVersions(key: string): Promise<StoredObjectVersion[]> {
        const Key = this.key(key), found: StoredObjectVersion[] = [];
        let KeyMarker: string | undefined, VersionIdMarker: string | undefined;
        for (let page = 0; ; page++) {
            if (page >= 10) throw Error('Version lookup is ambiguous');
            const r = await this.client.send(new ListObjectVersionsCommand({ Bucket: this.bucket, Prefix: Key, KeyMarker, VersionIdMarker, MaxKeys: 1000 }), { abortSignal: AbortSignal.timeout(15_000) });
            // Keys are listed in order and this key sorts first under its own prefix, so a longer key ends the lookup.
            let passed = false;
            for (const [items, deleteMarker] of [[r.Versions ?? [], false], [r.DeleteMarkers ?? [], true]] as const) for (const item of items) {
                if (item.Key !== Key) { passed = true; continue; }
                if (!validVersionId(item.VersionId)) throw Error('Unidentified storage version');
                found.push({ versionId: item.VersionId, deleteMarker });
            }
            if (found.length > 1000) throw Error('Version lookup is ambiguous');
            if (passed || !r.IsTruncated) return found;
            if (!r.NextKeyMarker || (r.NextKeyMarker === KeyMarker && r.NextVersionIdMarker === VersionIdMarker)) throw Error('Version lookup is ambiguous');
            KeyMarker = r.NextKeyMarker; VersionIdMarker = r.NextVersionIdMarker;
        }
    }

    /** GET supplies size and Content-Range itself, avoiding a serial HEAD on normal reads. */
    async readHttpRange(key: string, header: string | null): Promise<HttpObjectRead | null> {
        const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
        const range = match && (match[1] || match[2]) ? match[0] : undefined;
        if (range && match && (match.slice(1).some(value => value && !Number.isSafeInteger(Number(value))) ||
            (!match[1] && Number(match[2]) === 0) || (match[1] && match[2] && Number(match[2]) < Number(match[1]))))
            return this.readRangeWithHead(key, header);
        try {
            const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(key), ...(range ? { Range: range } : {}) }));
            if (!result.Body) throw Error('Object body missing');
            const body = result.Body.transformToWebStream();
            try {
                const size = result.ContentLength;
                if (size === undefined || !Number.isSafeInteger(size) || size < 0) throw Error('Invalid storage read metadata');
                if (!range) {
                    if (result.ContentRange || result.$metadata.httpStatusCode !== 200) throw Error('Invalid storage read metadata');
                    return { status: 200, totalSize: size, size, body, etag: result.ETag ?? '', contentType: result.ContentType };
                }
                const returned = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(result.ContentRange ?? '');
                if (!returned || result.$metadata.httpStatusCode !== 206) throw Error('Invalid storage range response');
                const [start, end, totalSize] = returned.slice(1).map(Number);
                const expected = requestedByteRange(range, totalSize);
                if (![start, end, totalSize].every(Number.isSafeInteger) || !expected || expected.invalid ||
                    expected.start !== start || expected.end !== end || size !== end - start + 1)
                    throw Error('Invalid storage range response');
                return { status: 206, totalSize, size, body, etag: result.ETag ?? '', contentType: result.ContentType, contentRange: result.ContentRange };
            } catch (error) { await body.cancel().catch(() => {}); throw error; }
        } catch (error) {
            if (this.missing(error)) return null;
            if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 416) {
                const head = await this.head(key);
                if (!head) return null;
                if (requestedByteRange(header, head.size)?.invalid) return { status: 416, totalSize: head.size };
            }
            throw error;
        }
    }

    private async readRangeWithHead(key: string, header: string | null): Promise<HttpObjectRead | null> {
        const head = await this.head(key);
        if (!head) return null;
        const range = requestedByteRange(header, head.size);
        if (range?.invalid) return { status: 416, totalSize: head.size };
        const object = await this.get(key, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined);
        if (!object) return null;
        const metadata = new Headers(); object.writeHttpMetadata(metadata);
        return { status: range ? 206 : 200, totalSize: head.size, size: range ? range.end - range.start + 1 : head.size,
            body: object.body, etag: object.httpEtag, contentType: metadata.get('content-type') ?? undefined,
            ...(range ? { contentRange: `bytes ${range.start}-${range.end}/${head.size}` } : {}) };
    }

    /** Without a mode only an unversioned bucket is accepted (the original contract). */
    async beginMultipart(key: string, contentType: string, owner?:string, mode?:DirectStorageMode) {
        if (mode === undefined) await this.assertDirectReady();
        else if (await this.directStorageMode() !== mode) throw Error('DIRECT_STORAGE_MODE_CHANGED');
        const pending=await this.findMultipart(key);
        if(pending.length===1)return pending[0];
        if(pending.length>1)throw Error('Multiple multipart identities require reconciliation');
        const r = await this.client.send(new CreateMultipartUploadCommand({Bucket:this.bucket,Key:this.key(key),ContentType:contentType,ChecksumAlgorithm:'SHA256',...(owner?{Metadata:{'lifewood-upload-session':owner}}:{})}), {abortSignal:AbortSignal.timeout(15_000)});
        if (!r.UploadId) throw Error('Multipart identity missing');
        return r.UploadId;
    }
    async findMultipart(key:string){
        const r=await this.client.send(new ListMultipartUploadsCommand({Bucket:this.bucket,Prefix:this.key(key),MaxUploads:3}),{abortSignal:AbortSignal.timeout(15000)});
        if(r.IsTruncated)throw Error('Multipart identity lookup is ambiguous');
        return (r.Uploads||[]).filter(item=>item.Key===this.key(key)&&item.UploadId).map(item=>item.UploadId!);
    }
    /** Rechecked at most once a minute, so a configuration change is noticed without restarting. */
    directStorageMode(): Promise<DirectStorageMode> {
        if (this.directMode && performance.now() - this.directMode.at < 60_000) return this.directMode.value;
        const entry = { at: performance.now(), value: this.client.send(new GetBucketVersioningCommand({Bucket:this.bucket}),{abortSignal:AbortSignal.timeout(15000)}).then(result => {
            if (!result.Status) return 'unversioned' as const;
            if (result.Status === 'Enabled') return 'enabled' as const;
            throw Error('DIRECT_NATIVE_VERSIONING_UNSUPPORTED');
        }) };
        entry.value.catch(() => { if (this.directMode === entry) this.directMode = undefined; });
        this.directMode = entry;
        return entry.value;
    }
    /** Callers that delete by key alone (operator abandonment) still require a bucket without versioning. */
    async assertDirectReady() {
        if (await this.directStorageMode() !== 'unversioned') throw Error('DIRECT_NATIVE_VERSIONING_UNSUPPORTED');
    }
    async signPart(key: string, uploadId: string, part: number, length: number, sha256: string) {
        return getSignedUrl(this.client, new UploadPartCommand({Bucket:this.bucket,Key:this.key(key),UploadId:uploadId,PartNumber:part,ContentLength:length,ChecksumSHA256:sha256}),
            {expiresIn:300,signableHeaders:new Set(['content-length','x-amz-checksum-sha256']),unhoistableHeaders:new Set(['x-amz-checksum-sha256'])});
    }
    async parts(key: string, uploadId: string) {
        const r = await this.client.send(new ListPartsCommand({Bucket:this.bucket,Key:this.key(key),UploadId:uploadId}), {abortSignal:AbortSignal.timeout(15_000)});
        if (r.IsTruncated) throw Error('Too many upload parts');
        return (r.Parts || []).map(p=>({number:p.PartNumber || 0,size:p.Size || 0,etag:p.ETag || '',sha256:p.ChecksumSHA256 || ''}));
    }
    async completeMultipart(key: string, uploadId: string, parts: {number:number;etag:string;sha256:string}[]) {
        return this.client.send(new CompleteMultipartUploadCommand({Bucket:this.bucket,Key:this.key(key),UploadId:uploadId,MultipartUpload:{Parts:parts.map(p=>({PartNumber:p.number,ETag:p.etag,ChecksumSHA256:p.sha256}))}}), {abortSignal:AbortSignal.timeout(30_000)});
    }
    async abortMultipart(key: string, uploadId: string) {
        await this.client.send(new AbortMultipartUploadCommand({Bucket:this.bucket,Key:this.key(key),UploadId:uploadId}), {abortSignal:AbortSignal.timeout(15_000)});
    }
    async copy(source: string, destination: string, etag: string, contentType?: string, owner?:string, createOnly=false, receipt?:{handle?:string;created:(handle:string)=>Promise<void>;assertCurrent:()=>Promise<void>;signal?:AbortSignal;sourceVersionId?:string}):Promise<{etag:string;versionId?:string}> {
        // Keep all verification I/O within the service's fenced 15-minute lease.
        const copyTimeout=Math.min(this.storageTimeoutMs,120_000);
        // The direct-upload service never signs writes to this destination.
        if (this.preventOverwrite && await this.head(destination)) throw Object.assign(Error('Object already exists'), {$metadata:{httpStatusCode:412}});
        // A versioned source is pinned to its exact version as well as its ETag.
        const sourceVersionId=receipt?.sourceVersionId;
        if(sourceVersionId!==undefined&&!validVersionId(sourceVersionId))throw Error('Invalid object version');
        const copySource=`${this.bucket}/${this.key(source).split('/').map(encodeURIComponent).join('/')}${sourceVersionId?`?versionId=${encodeURIComponent(sourceVersionId)}`:''}`,match=`"${etag.replaceAll('"','')}"`;
        if(this.preventOverwrite||createOnly){
            // Conditional completion is atomic; HEAD alone cannot prevent a race.
            await receipt?.assertCurrent();
            let uploadId=receipt?.handle;
            if(!uploadId){
                const created=await this.client.send(new CreateMultipartUploadCommand({Bucket:this.bucket,Key:this.key(destination),ContentType:contentType||'application/octet-stream',...(owner?{Metadata:{'lifewood-upload-session':owner}}:{})}),{abortSignal:AbortSignal.timeout(15000)});
                if(!created.UploadId)throw Error('Copy identity missing');uploadId=created.UploadId;
                try{await receipt?.created(uploadId);}catch(error){await this.abortMultipart(destination,uploadId).catch(()=>{});throw error;}
            }
            // A caller's signal (a background yield) interrupts the copy, its backoff and the conditional completion,
            // never the receipt creation above, whose handle must be saved. The receipt is kept for the next attempt.
            const signal=receipt?.signal,within=(ms:number)=>signal?AbortSignal.any([AbortSignal.timeout(ms),signal]):AbortSignal.timeout(ms);
            const stopIfAborted=()=>{if(signal?.aborted)throw signal.reason;};
            try{
                stopIfAborted();
                await receipt?.assertCurrent();
                // Wasabi reports 500/503 (also as a 200 error body) as transient. Re-copying the same part of the same
                // receipt is idempotent and the source stays pinned by CopySourceIfMatch; at most three attempts, all
                // within the original copy budget, and the upload claim is rechecked before each retry.
                // The budget covers the UploadPartCopy attempts and their backoff only, on a monotonic clock. It is
                // recomputed after each claim check, because a slow check or a late timer can spend it; once less than
                // one whole millisecond remains, no further copy request is sent and the last storage error stands.
                const deadline=performance.now()+copyTimeout;let copied:{CopyPartResult?:{ETag?:string}},last:unknown;
                for(let attempt=0;;attempt++){
                    const remaining=Math.floor(deadline-performance.now());
                    if(remaining<1)throw last??Object.assign(Error('Copy budget exhausted'),{name:'TimeoutError'});
                    stopIfAborted();
                    try{copied=await this.client.send(new UploadPartCopyCommand({Bucket:this.bucket,Key:this.key(destination),UploadId:uploadId,PartNumber:1,CopySource:copySource,CopySourceIfMatch:match}),{abortSignal:within(remaining)});break;}
                    catch(error){
                        stopIfAborted();
                        const status=(error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode,name=(error as Error).name,delay=[1000,3000][attempt];
                        const transient=status===500||status===503||['InternalError','ServiceUnavailable','SlowDown'].includes(name);
                        if(!transient||delay===undefined||performance.now()+delay>=deadline)throw error;
                        last=error;
                        await new Promise<void>(resolve=>{
                            const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',done);resolve();};
                            const timer=setTimeout(done,delay);signal?.addEventListener('abort',done,{once:true});
                        });
                        stopIfAborted();
                        await receipt?.assertCurrent();
                    }
                }
                stopIfAborted();
                await receipt?.assertCurrent();
                // If this is interrupted after Wasabi completed the object, the next attempt confirms it by owner and size.
                const done=await this.client.send(new CompleteMultipartUploadCommand({Bucket:this.bucket,Key:this.key(destination),UploadId:uploadId,IfNoneMatch:'*',MultipartUpload:{Parts:[{PartNumber:1,ETag:copied.CopyPartResult?.ETag}]}}),{abortSignal:within(30000)}).catch(error=>{stopIfAborted();throw error;});
                if(!done.ETag)throw Error('Copy result unconfirmed');return {etag:done.ETag.replaceAll('"',''),...(validVersionId(done.VersionId)?{versionId:done.VersionId}:{})};
            }catch(error){if(!receipt)await this.abortMultipart(destination,uploadId).catch(()=>{});throw error;}
        }
        const r = await this.client.send(new CopyObjectCommand({Bucket:this.bucket,Key:this.key(destination),CopySource:copySource,CopySourceIfMatch:match,MetadataDirective:'REPLACE',ContentType:contentType || 'application/octet-stream',...(owner?{Metadata:{'lifewood-upload-session':owner}}:{})}), {abortSignal:AbortSignal.timeout(copyTimeout)});
        if (!r.CopyObjectResult?.ETag) throw Error('Copy result unconfirmed');
        return {etag:r.CopyObjectResult.ETag.replaceAll('"',''),...(validVersionId(r.VersionId)?{versionId:r.VersionId}:{})};
    }
    async signedRead(key: string, name: string, contentType: string, disposition: string) {
        return getSignedUrl(this.client,new GetObjectCommand({Bucket:this.bucket,Key:this.key(key),ResponseContentType:contentType,ResponseContentDisposition:`${disposition}; filename*=UTF-8''${encodeURIComponent(name)}`,ResponseCacheControl:'private, no-store'}),{expiresIn:60});
    }
}
