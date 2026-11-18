import {PublicError} from './security-controls';
export const uploadAdmissionReasons=['UPLOAD_ACCOUNT_LIMIT','UPLOAD_SITE_LIMIT','UPLOAD_STAGING_QUOTA','UPLOAD_RESERVATION_LIMIT','UPLOAD_CAPACITY_CHANGED'] as const;
export type UploadAdmissionReason=typeof uploadAdmissionReasons[number];
export class UploadAdmissionError extends PublicError {
  constructor(message:string,readonly reasonCode:UploadAdmissionReason){super(message,429,'UPLOAD_BUSY');}
}
