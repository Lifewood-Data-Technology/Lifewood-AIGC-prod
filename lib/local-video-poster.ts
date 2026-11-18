/** Local File only: never downloads a video through the application server. */
export function localVideoPoster(file:File,signal:AbortSignal):Promise<Blob|null>{
  return new Promise(resolve=>{
    if(signal.aborted)return resolve(null);
    const video=document.createElement('video'),canvas=document.createElement('canvas'),url=URL.createObjectURL(file);
    let settled=false,capturing=false,frameCallback:number|undefined;
    let frameTimer:ReturnType<typeof setTimeout>|undefined;
    const finish=(blob:Blob|null)=>{
      if(settled)return;settled=true;clearTimeout(timer);clearTimeout(frameTimer);signal.removeEventListener('abort',abort);
      if(frameCallback!==undefined)video.cancelVideoFrameCallback?.(frameCallback);
      video.onloadeddata=video.onseeked=video.onerror=null;video.pause();video.removeAttribute('src');video.load();video.remove();
      URL.revokeObjectURL(url);canvas.width=canvas.height=0;resolve(blob);
    };
    const abort=()=>finish(null),timer=setTimeout(abort,20000);
    const capture=()=>{
      if(settled||capturing)return;capturing=true;
      if(!video.videoWidth||!video.videoHeight)return finish(null);
      const ratio=Math.min(1,480/Math.max(video.videoWidth,video.videoHeight));
      canvas.width=Math.max(1,Math.round(video.videoWidth*ratio));canvas.height=Math.max(1,Math.round(video.videoHeight*ratio));
      try{const context=canvas.getContext('2d');if(!context)return finish(null);context.drawImage(video,0,0,canvas.width,canvas.height);canvas.toBlob(blob=>finish(blob&&blob.size<=2*1024*1024?blob:null),'image/jpeg',.84);}catch{finish(null);}
    };
    signal.addEventListener('abort',abort,{once:true});
    video.muted=true;video.playsInline=true;video.preload='metadata';
    const decoded=async()=>{
      if(settled||capturing)return;
      try{await video.play();}catch{/* The bounded fallback also supports autoplay rejection. */}
      if(settled)return;
      const ready=()=>{video.pause();capture();};
      frameTimer=setTimeout(ready,350);
      if(video.requestVideoFrameCallback)frameCallback=video.requestVideoFrameCallback(ready);
    };
    video.onerror=abort;video.onseeked=decoded;
    video.onloadeddata=()=>{
      if(settled)return;
      const target=Number.isFinite(video.duration)&&video.duration>.1?Math.min(1,video.duration/2):0;
      if(target>0){try{video.currentTime=target;}catch{void decoded();}}else void decoded();
    };
    Object.assign(video.style,{position:'fixed',left:'-10000px',width:'2px',height:'2px',opacity:'0',pointerEvents:'none'});document.body.appendChild(video);
    video.src=url;video.load();
  });
}
