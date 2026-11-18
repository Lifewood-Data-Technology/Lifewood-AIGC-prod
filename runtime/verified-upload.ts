/** Server-created identities only: neither JSON nor client metadata can brand a value. */
type VerifiedObject = { key: string; etag: string; sha256: string; verification?: 'storage-sha256-parts-v1'; promote?:(key:string,type?:string)=>Promise<{etag:string}> };
const verified = new WeakMap<object, VerifiedObject>();
export function markVerifiedUpload(value: object, object: VerifiedObject) { verified.set(value, object); }
export function verifiedUpload(value: object) { return verified.get(value); }
export function copyVerifiedUpload(from: object, to: object) { const record = verified.get(from); if (record) verified.set(to, record); }

/** A server-only reference, never an empty Blob masquerading as uploaded bytes. */
export function storedUploadFile(info: {name:string;type:string;size:number}, record: VerifiedObject) {
    const file = new File([], info.name, {type:info.type});
    const noBody = () => { throw Error('Stored upload has metadata only; file body access is forbidden.'); };
    Object.defineProperties(file, {
        size: {value:info.size}, arrayBuffer: {value:noBody}, bytes: {value:noBody},
        stream: {value:noBody}, slice: {value:noBody}, text: {value:noBody},
    });
    markVerifiedUpload(file, {...record, verification:'storage-sha256-parts-v1'});
    return file;
}
