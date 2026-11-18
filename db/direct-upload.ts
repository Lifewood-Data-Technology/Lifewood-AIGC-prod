import { env, shuttingDown, waitUntil } from "../runtime/node-environment";
import {createUploadMaintenance} from './upload-maintenance';
import { businessScopes } from "./business-deletion";
import { createDirectUploadService } from "./direct-upload-service";
import { uploadProjectFile, uploadLibraryFile, uploadLibraryThumbnail, uploadProjectRequestDocument, productionWorkspaceContext, directVideoPreviewAuthority, uploadAutomaticVideoPreview } from "./backend";
import { stageProductionFile, cleanupProductionStaging } from "./production-workspace";
import { PublicError } from "../lib/security-controls";
// Default 5-minute wait and 4 unfinished jobs; maintenance stops starting work once shutdown begins.
const scheduleStagingMaintenance=createUploadMaintenance(actor=>cleanupProductionStaging(actor),waitUntil,undefined,undefined,()=>!shuttingDown());

export function directUploads() {
  if(process.env.FILE_TRANSFER_MODE!=='direct')throw new PublicError('Direct transfers are not enabled.',409,'DIRECT_TRANSFER_DISABLED');
  return directUploadService();
}
export function directUploadService() {
  return createDirectUploadService({db:env.DB,bucket:env.FILES,
    previewAuthority:directVideoPreviewAuthority,
    async authorizeList(actor,taskId){await productionWorkspaceContext(actor,taskId,true,true);},
    observe:metric=>console.info({event:'direct-upload.timing',...metric}),
    async beforeCreate(actor,input){if(input.endpoint==='/api/production-workspace')scheduleStagingMaintenance(actor);},
    async dispatch(actor,input,file,thumbnail,execution){
      const f=input.fields;
      if(f.scope==='automatic-preview')return uploadAutomaticVideoPreview(actor,f.parentUploadId||'',f.thumbnailForVersionId||'',file,execution);
      if(f.parentUploadId)throw new PublicError('Invalid preview destination.');
      if(input.endpoint==='/api/production-workspace')return stageProductionFile(actor,f.task||'',input.id,f.purpose||'',f.category||'',file,execution);
      if(input.endpoint==='/api/request-documents')return uploadProjectRequestDocument(actor,f.requestId||'',file,execution);
      if(f.thumbnailForVersionId)return uploadLibraryThumbnail(actor,f.thumbnailForVersionId,file,f.forceThumbnail==='1',execution);
      if(f.scope==='library')return uploadLibraryFile(actor,f.folderId||'',file,f.assetName,f.logicalFileId,f.collectionId,f.relationType,thumbnail,execution);
      let sources:string[]=[];
      if(f.sourceAssetIds){const value:unknown=JSON.parse(f.sourceAssetIds);if(!Array.isArray(value)||value.length>50||value.some(x=>typeof x!=='string'))throw new PublicError('Invalid source assets.');sources=value;}
      return uploadProjectFile(actor,f.languageProjectId||'',f.directory||'',file,f.folderId,f.logicalFileId,sources,execution);
    },
    async scopes(input){
      if(input.fields.scope==='automatic-preview'){
        // dispatch already validated this parent; derive project scope on the
        // server, including targets that are still only production stages.
        const parent=await env.DB.prepare('SELECT payload_json FROM direct_upload_sessions WHERE id=?').bind(input.fields.parentUploadId).first<{payload_json:string}>();
        if(!parent)throw new PublicError('Automatic preview unavailable.',403);
        const original=JSON.parse(parent.payload_json) as {fields:Record<string,string>};
        return businessScopes(env.DB,{taskId:original.fields.task||original.fields.languageProjectId,fileId:input.fields.thumbnailForVersionId,folderId:original.fields.folderId});
      }
      return businessScopes(env.DB,{taskId:input.fields.task||input.fields.languageProjectId,fileId:input.fields.logicalFileId||input.fields.thumbnailForVersionId,folderId:input.fields.folderId,requestId:input.fields.requestId});
    },
  });
}
