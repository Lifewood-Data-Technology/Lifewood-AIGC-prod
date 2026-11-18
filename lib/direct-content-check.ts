import { hasJpegStructure } from './jpeg-structure';

/** Browser checks are usability/content checks, never server attestations. */
export async function checkDirectContent(file: File, kind: 'requirement' | 'poster') {
    if (kind === 'poster') {
        if (file.type !== 'image/jpeg' || !file.size || file.size > 2 * 1024 * 1024 ||
            !hasJpegStructure(new Uint8Array(await file.arrayBuffer())))
            throw Error('The generated video preview must be a complete JPEG smaller than 2 MB.');
        return;
    }
    const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
    const prefix = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const begins = (...signature: number[]) => signature.every((byte, index) => prefix[index] === byte);
    if (file.type.split(';', 1)[0].toLowerCase() === 'text/html' ||
        (extension === 'pdf' && !begins(0x25, 0x50, 0x44, 0x46, 0x2d)) ||
        (['docx', 'pptx', 'xlsx'].includes(extension) && !begins(0x50, 0x4b, 0x03, 0x04)) ||
        (extension === 'png' && !begins(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) ||
        (['jpg', 'jpeg'].includes(extension) && !begins(0xff, 0xd8, 0xff)))
        throw Error('The document content does not match its file format. Upload the original supported document.');
}
