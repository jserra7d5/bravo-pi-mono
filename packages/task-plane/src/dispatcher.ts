import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TaskRecord } from "./types.js";
import { TaskRegistry } from "./registry.js";

export type DispatchRoute={sessionId?:string;sessionFile?:string;currentSessionId:()=>string|undefined;currentSessionFile:()=>string|undefined};
type Pending={record:TaskRecord;retries?:number};
const MAX_ENVELOPE_BYTES=4096;

/** Dispatches metadata-only terminal task notifications. Monitor stdout remains
 * exclusively in output_path and never becomes model-context content. */
export class Dispatcher {
 private pending:Pending[]=[];private timer?:NodeJS.Timeout;private flushing:Promise<void>=Promise.resolve();private closed=false;
 constructor(private pi:Pick<ExtensionAPI,"sendMessage">,private registry:TaskRegistry,private route:DispatchRoute){}
 setRoute(route:DispatchRoute){this.route=route;}
 terminal(r:TaskRecord){if(this.closed||r.notification_suppressed_reason)return;this.pending=this.pending.filter(p=>p.record.task_id!==r.task_id);this.pending.push({record:r});this.schedule(10);}
 flush():Promise<void>{if(this.timer)clearTimeout(this.timer);this.timer=undefined;this.flushing=this.flushing.then(()=>this.flushOnce()).catch(e=>console.warn(`task-plane dispatch flush failed: ${message(e)}`));return this.flushing;}
 private async flushOnce():Promise<void>{
  if(!this.pending.length||this.closed)return;const batch=this.pending.splice(0),accepted:TaskRecord[]=[];
  for(const p of batch){let r:TaskRecord|undefined;try{r=this.registry.get(p.record.task_id);}catch(error){this.retryPreclaim(p,error);continue;}if(!r||r.notification_suppressed_reason||!this.routeMatches(r)||!isDispatchableTerminal(r))continue;
   try{if(!this.registry.claimTerminal(r.task_id,r.owner_session_id))continue;r=this.registry.get(r.task_id)!;}catch(error){this.retryPreclaim(p,error);continue;}accepted.push(r);
  }
  if(!accepted.length)return;
  try{const content=accepted.map(envelope).join("\n");await this.pi.sendMessage({customType:"task-notification",content,display:true,details:{tasks:accepted.map(p=>p.task_id)}},{deliverAs:"followUp",triggerTurn:true});}
  catch(e){for(const r of accepted)this.persistDispatchFailure(r,e);return;}
  for(const r of accepted){const current=this.registry.get(r.task_id);if(!current||current.dispatch_state!=="dispatch_requested")continue;try{this.registry.updateDispatch(current.task_id,current.owner_session_id,current.record_version,"host_api_invoked");}catch{console.warn(`task-plane post-dispatch persistence failed for ${r.task_id}`);}}
 }
 private persistDispatchFailure(record:TaskRecord,error:unknown):void{const current=this.registry.get(record.task_id);if(!current||current.dispatch_state!=="dispatch_requested")return;try{this.registry.updateDispatch(current.task_id,current.owner_session_id,current.record_version,"dispatch_sync_failed",new Date(),message(error));}catch(e){console.warn(`task-plane dispatch failure persistence failed for ${record.task_id}: ${message(e)}`);}}
 private routeMatches(r:TaskRecord):boolean{if(r.owner_session_id!==this.route.sessionId||this.route.currentSessionId()!==r.owner_session_id)return false;const fs=[r.owner_session_file,this.route.sessionFile,this.route.currentSessionFile()];return fs.every(x=>x===undefined)||(fs.every(x=>typeof x==="string")&&new Set(fs).size===1);}
 private retryPreclaim(p:Pending,error:unknown):void{if(this.closed)return;const retries=(p.retries??0)+1;this.pending.push({...p,retries});const delay=Math.min(1_000,10*2**Math.min(retries,7));console.warn(`task-plane dispatch pre-claim failed for ${p.record.task_id}; retrying: ${message(error)}`);this.schedule(delay);}
 shutdown(){if(this.timer)clearTimeout(this.timer);this.timer=undefined;this.pending=[];}
 close(){this.shutdown();this.closed=true;}
 private schedule(delay=0){if(!this.timer){this.timer=setTimeout(()=>void this.flush(),delay);this.timer.unref?.();}}
}
function isDispatchableTerminal(r:TaskRecord){return ["completed","failed","stopped","timed_out"].includes(r.status);}
function message(e:unknown){return e instanceof Error?e.message:String(e);}
function xml10(v:unknown){let out="";for(const char of String(v)){const cp=char.codePointAt(0)!;out+=cp===0x9||cp===0xa||cp===0xd||cp>=0x20&&cp<=0xd7ff||cp>=0xe000&&cp<=0xfffd||cp>=0x10000&&cp<=0x10ffff?char:"�";}return out;}
function esc(v:unknown){return String(v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
function xml(r:TaskRecord,outputPath:string,signal?:string){const x=(k:string,v:unknown)=>`  <${k}>${esc(v)}</${k}>`;return ["<task_notification not_user_input=\"true\">",x("task_id",xml10(r.task_id)),x("type",r.type),x("status",r.status),x("output_path",outputPath),...(r.exit_code!==undefined?[x("exit_code",r.exit_code)]:[]),...(signal!==undefined?[x("signal",signal)]:[]),...(r.stop_reason?[x("stop_reason",r.stop_reason)]:[]),...(r.failure_reason?[x("failure_reason",r.failure_reason)]:[]),"</task_notification>"].join("\n");}
function fit(value:string,render:(candidate:string)=>string):string{if(Buffer.byteLength(render(value))<=MAX_ENVELOPE_BYTES)return value;const marker="…[truncated]",chars=Array.from(value);let low=0,high=chars.length;while(low<high){const mid=Math.ceil((low+high)/2);if(Buffer.byteLength(render(chars.slice(0,mid).join("")+marker))<=MAX_ENVELOPE_BYTES)low=mid;else high=mid-1;}return chars.slice(0,low).join("")+marker;}
/** One well-formed XML 1.0 terminal envelope, bounded independently before flush batching. */
export function envelope(r:TaskRecord){let outputPath=xml10(r.output_path),signal=r.signal===undefined?undefined:xml10(r.signal);outputPath=fit(outputPath,candidate=>xml(r,candidate,signal));if(signal!==undefined)signal=fit(signal,candidate=>xml(r,outputPath,candidate));const value=xml(r,outputPath,signal);if(Buffer.byteLength(value)>MAX_ENVELOPE_BYTES)throw new Error("Fixed task notification metadata exceeds envelope limit.");return value;}
