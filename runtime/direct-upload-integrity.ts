import { createHash } from 'node:crypto';
import {directUploadMaxBytes} from '../lib/upload-policy';
import { directPartLength, directPartSize } from '../lib/direct-upload-contract';
import { PublicError } from '../lib/security-controls';

/** Storage-validated multipart SHA-256 is distinct from a whole-file SHA-256. */
export function storedMultipartIntegrity(size: number, parts: Record<string, string>,
    stored: { checksumSha256?: string; checksumType?: string }) {
    if (!Number.isSafeInteger(size) || size < 1 || size > directUploadMaxBytes)
        throw new PublicError('Upload parts do not match.', 409, 'UPLOAD_PARTS_MISMATCH');
    const count = Math.ceil(size / directPartSize);
    if (Object.keys(parts).length !== count) throw new PublicError('Upload parts do not match.', 409, 'UPLOAD_PARTS_MISMATCH');
    const manifest: Array<[number, number, string]> = [];
    const digests: Buffer[] = [];
    for (let number = 1; number <= count; number++) {
        const digest = parts[String(number)];
        if (!digest || !/^[A-Za-z0-9+/]{43}=$/.test(digest) || Buffer.from(digest, 'base64').toString('base64') !== digest)
            throw new PublicError('Upload parts do not match.', 409, 'UPLOAD_PARTS_MISMATCH');
        digests.push(Buffer.from(digest, 'base64'));
        manifest.push([number, directPartLength(size, number), digest]);
    }
    if (!stored.checksumSha256) throw new PublicError('Storage checksum confirmation is unavailable. No file was downloaded by the application.', 503, 'DIRECT_CHECKSUM_UNAVAILABLE');
    const expected = createHash('sha256').update(Buffer.concat(digests)).digest('base64') + '-' + count;
    if (stored.checksumSha256 !== expected || (stored.checksumType && stored.checksumType !== 'COMPOSITE'))
        throw new PublicError('Stored checksum mismatch.', 409, 'UPLOAD_CHECKSUM_MISMATCH');
    return 'wasabi-sha256-parts-v1:' + createHash('sha256').update(JSON.stringify({ size, manifest })).digest('hex');
}
