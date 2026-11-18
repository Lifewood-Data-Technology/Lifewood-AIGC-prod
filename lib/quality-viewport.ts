/** The annotation plane retains its existing 16:9 percentage coordinate space. */
export function fitQualityFrame(width:number,height:number){
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)return {width:0,height:0};
  const fitted=Math.min(width,height*16/9);
  return {width:Math.floor(fitted*100)/100,height:Math.floor(fitted*9/16*100)/100};
}
