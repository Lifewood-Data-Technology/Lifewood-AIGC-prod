import {env} from "../runtime/node-environment";
export function storageLocation(){
 const runtime=env as unknown as {LIFEWOOD_STORAGE?:string;WASABI_BUCKET?:string;WASABI_REGION?:string;WASABI_ENDPOINT?:string};
 if(runtime.LIFEWOOD_STORAGE==='wasabi'){
  if(!runtime.WASABI_BUCKET||!runtime.WASABI_REGION||!runtime.WASABI_ENDPOINT)throw Error('Incomplete Wasabi configuration');
  return {provider:'wasabi',bucket:runtime.WASABI_BUCKET,region:runtime.WASABI_REGION,endpoint:runtime.WASABI_ENDPOINT};
 }
 throw new Error('Wasabi storage is not configured');
}
