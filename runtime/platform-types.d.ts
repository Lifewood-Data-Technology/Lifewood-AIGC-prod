/** Platform types used by the shared HTTP response wrapper. */
declare class HTMLRewriter {
  on(selector:string, handlers:{element(element:{setAttribute(name:string,value:string):void;append(content:string,options?:{html?:boolean}):void}):void}):this;
  transform(response:Response):Response;
}
interface RequestInit { duplex?: "half"; }
