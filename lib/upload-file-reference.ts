import {filePreviewKind} from './request-security';
export type UploadedFileReference={id:string;storage:'file'|'staged'|'requirement';mimeType:string};
export function uploadedFileUrl(file:UploadedFileReference,download=false) {
 if(!file.id||!['file','staged','requirement'].includes(file.storage))return '';
 const endpoint=file.storage==='staged'?'/api/production-workspace?file=':file.storage==='requirement'?'/api/request-documents?id=':'/api/files?id=';
 return `${endpoint}${encodeURIComponent(file.id)}${download?'&download=1':''}`;
}
export function uploadedFilePreviewable(file:UploadedFileReference){return !!filePreviewKind(file.mimeType);}
export function uploadDisplayMime(file:{name:string;type:string}) {
 if(file.type&&file.type!=='application/octet-stream')return file.type;
 return ({mp4:'video/mp4',mov:'video/quicktime',webm:'video/webm',mp3:'audio/mpeg',wav:'audio/wav',m4a:'audio/mp4',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',pdf:'application/pdf'} as Record<string,string>)[file.name.split('.').pop()?.toLowerCase()||'']||'application/octet-stream';
}
