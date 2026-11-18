/** New-upload rules only. Existing files retain their categories and read permissions. */
// UI GB/MB labels follow the existing binary byte convention.
export const directUploadMaxBytes = 1024 ** 3;
export const legacyUploadMaxBytes = 100 * 1024 ** 2;
export const requirementUploadMaxBytes = 25 * 1024 ** 2;
export const previewUploadMaxBytes = 2 * 1024 ** 2;
export function normalUploadMaxBytes(direct: boolean) {
 return direct ? directUploadMaxBytes : legacyUploadMaxBytes;
}
export function uploadSizeLabel(bytes: number) {
 return bytes >= 1024 ** 3 ? `${bytes / 1024 ** 3} GB` : `${bytes / 1024 ** 2} MB`;
}
export function uploadSizeError(file: {size: number}, direct: boolean, locale: 'zh'|'en' = 'en') {
 const max = normalUploadMaxBytes(direct);
 if (Number.isSafeInteger(file.size) && file.size > 0 && file.size <= max) return '';
 return locale === 'zh' ? `单文件须为 1 B–${uploadSizeLabel(max)}。` : `Each file must be 1 B–${uploadSizeLabel(max)}.`;
}
export const uploadExtensions = {
 video: ['mp4','mov','m4v','webm','mkv','avi','mpeg','mpg'],
 audio: ['mp3','wav','m4a','aac','flac','ogg','opus'],
 image: ['jpg','jpeg','png','gif','webp','bmp','tif','tiff'],
 document: ['pdf','doc','docx','xls','xlsx','ppt','pptx','txt','csv','md','srt','vtt','rtf'],
 project: ['zip','rar','7z','tar','gz','prproj','aep','drp','fcpxml','xml','blend','psd','ai'],
 requirement: ['pdf','doc','docx','ppt','pptx','xls','xlsx','txt','md','csv','json','png','jpg','jpeg','webp'],
 report: ['pdf','doc','docx','xls','xlsx','png','jpg','jpeg','txt'],
} as const;
export type UploadPurpose = keyof typeof uploadExtensions | 'mixed' | 'media';
export function uploadAccept(purpose:UploadPurpose='mixed') {
 const extensions=purpose==='mixed'?Object.values(uploadExtensions).flat():purpose==='media'?[...uploadExtensions.video,...uploadExtensions.audio,...uploadExtensions.image]:uploadExtensions[purpose];
 return [...new Set(extensions)].map(ext=>`.${ext}`).join(',');
}
export function categoryUploadPurpose(category:string):UploadPurpose {
 return ({final:'video',video:'video',image:'image',voice:'audio',music:'audio',script:'document',project:'project'} as Record<string,UploadPurpose>)[category] || 'mixed';
}
export function folderUploadPurpose(code:string):UploadPurpose {
 if(code==='04.reports')return 'report';
 if(code==='01'||code.startsWith('01.'))return 'requirement';
 if(/^LIB\.collection\..*\.final$/.test(code))return 'media';
 // Collection sources route all non-media documents and engineering files here.
 // This is not the standalone engineering directory (03.project / LIB.project).
 if(code==='LIB.collection.source.project')return 'mixed';
 if(code==='LIB.document')return 'document';
 if(code==='03.render.video'||code==='03.preview'||/LIB\..*video$/.test(code))return 'video';
 if(code==='03.render.audio'||code==='03.voice'||code==='03.music'||/LIB\..*(audio|music|voice)$/.test(code))return 'audio';
 if(code==='03.image'||/LIB\..*image$/.test(code))return 'image';
 if(code==='03.script')return 'document';
 if(code==='03.project'||/LIB\..*project$/.test(code))return 'project';
 return 'mixed';
}
/** Resolve inherited rules for user-created subfolders; the server resolves its own records. */
export function folderTreeUploadPurpose(folder:Record<string,unknown>|undefined,folders:Record<string,unknown>[]):UploadPurpose {
 const visited=new Set<string>();
 while(folder&&!visited.has(String(folder.id))){visited.add(String(folder.id));const purpose=folderUploadPurpose(String(folder.folder_code||''));if(purpose!=='mixed')return purpose;folder=folders.find(row=>row.id===folder?.parent_folder_id);}
 return 'mixed';
}
function mimeFamily(mime:string) {
 if(/^(video|audio|image)\//.test(mime))return mime.split('/')[0];
 if(mime.startsWith('text/')||/pdf|msword|officedocument|spreadsheet|presentation|subrip|rtf|json/.test(mime))return 'document';
 if(/zip|compressed|archive|rar|tar|gzip/.test(mime))return 'archive';
 return '';
}
export function uploadTypeError(file:{name:string;type:string},purpose:UploadPurpose='mixed',locale:'zh'|'en'='en'):string {
 const ext=file.name.split('.').pop()?.toLowerCase()||'';
 const allowed=uploadAccept(purpose).split(',').includes(`.${ext}`);
 if(!allowed)return locale==='zh'?`${file.name}：不支持此格式，请选择 ${uploadAccept(purpose)}`:`${file.name}: unsupported format. Choose ${uploadAccept(purpose)}`;
 const family=mimeFamily(file.type.toLowerCase().split(';')[0]);
 const extFamily=uploadExtensions.video.includes(ext as never)?'video':uploadExtensions.audio.includes(ext as never)?'audio':uploadExtensions.image.includes(ext as never)?'image':['zip','rar','7z','tar','gz'].includes(ext)?'archive':uploadExtensions.project.includes(ext as never)?'': 'document';
 if(family&&extFamily&&family!==extFamily)return locale==='zh'?`${file.name}：扩展名与文件类型不一致。`:`${file.name}: the extension does not match the file type.`;
 return '';
}
