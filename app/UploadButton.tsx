"use client";
import {useRef,useState} from "react";
import {uploadTypeError,type UploadPurpose} from "../lib/upload-policy";
import OperationDialog from "./OperationDialog";
import UploadDropzone from "./UploadDropzone";
import UploadQueue, {formatUploadSize} from "./UploadQueue";
/** Selection is reviewable before invoking the existing authorized upload handler. */
export default function UploadButton({locale,disabled=false,upload,purpose='mixed'}:{locale:"zh"|"en";disabled?:boolean;upload:(file:File)=>Promise<unknown>;purpose?:UploadPurpose}) {
 const zh=locale==="zh",[open,setOpen]=useState(false),[file,setFile]=useState<File|null>(null),[lastFile,setLastFile]=useState<File|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),sending=useRef(false);
 const start=async()=>{if(!file||sending.current)return;const error=uploadTypeError(file,purpose,locale);if(error){setError(error);return;}sending.current=true;setBusy(true);setLastFile(file);setFile(null);try{await upload(file);}finally{sending.current=false;setBusy(false);}};
 const close=()=>{setOpen(false);setFile(null);setLastFile(null);setError('');};
 return <><button type="button" className="command-primary" disabled={disabled} onClick={()=>setOpen(true)}>↑ {zh?"上传":"Upload"}</button>{open&&<OperationDialog title={zh?"上传文件":"Upload files"} locale={locale} className="upload-picker-dialog" onDismiss={busy?undefined:close}>
 <div data-dialog-toolbar className="upload-fixed-chooser"><UploadDropzone locale={locale} purpose={purpose} disabled={busy} onFiles={files=>{setFile(files[0]);setError('');}}/>{error&&<p role="alert">{error}</p>}</div>
 {file&&<UploadQueue locale={locale} items={[{id:"selected",name:file.name,size:file.size,progress:0,phase:"queued"}]} describe={()=>zh?"待上传":"Ready to upload"} remove={()=>setFile(null)}/>}
 <footer><span className="upload-footer-summary">{file||lastFile?`1 ${zh?'个文件':'file'} · ${formatUploadSize((file||lastFile)!.size)}`:zh?'无待上传文件':'No queued files'}</span><button type="button" className="secondary-button" disabled={busy} onClick={close}>{zh?'完成':'Done'}</button>{file&&<button type="button" className="primary-button" disabled={busy} onClick={()=>void start()}>{zh?"开始上传":"Upload file"}</button>}</footer>
 </OperationDialog>}</>;
}
