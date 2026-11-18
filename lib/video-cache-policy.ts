/** Encoded byte budget per page, separate from native decoder memory and file size. */
export const videoFileLimit = 1024 ** 3;
export function readVideoCacheBudget(values:Record<string,string|undefined>={}) {
  const raw=values.LIFEWOOD_VIDEO_CACHE_MIB;
  if(raw!==undefined&&(!/^\d+$/.test(raw)||Number(raw)<32||Number(raw)>512))throw Error('LIFEWOOD_VIDEO_CACHE_MIB must be an integer from 32 to 512');
  return Number(raw??256)*1024**2;
}
type Entry={owner:object;bytes:Uint8Array;priority:boolean;evicted:()=>void};
export class VideoBlockCache {
  private entries=new Map<string,Entry>();
  private bytes=0;
  readonly limit:number;
  constructor(limit:number=readVideoCacheBudget()) {this.limit=limit;if(!Number.isSafeInteger(limit)||limit<512*1024)throw Error('Invalid video cache budget');}
  get residentBytes(){return this.bytes;}
  touch(key:string){const value=this.entries.get(key);if(value){this.entries.delete(key);this.entries.set(key,value);}}
  put(key:string,entry:Entry){
    if(entry.bytes.byteLength>this.limit)throw Error('Video block exceeds cache budget');
    this.remove(key);
    while(this.bytes+entry.bytes.byteLength>this.limit){const victim=[...this.entries].find(([,value])=>!value.priority)||this.entries.entries().next().value;if(!victim)throw Error('Video cache accounting failed');this.remove(victim[0]);}
    this.entries.set(key,entry);this.bytes+=entry.bytes.byteLength;
  }
  private remove(key:string){const entry=this.entries.get(key);if(entry){this.entries.delete(key);this.bytes-=entry.bytes.byteLength;entry.evicted();}}
  release(owner:object){for(const [key,entry]of this.entries)if(entry.owner===owner)this.remove(key);}
}
