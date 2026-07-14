import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TaskRecord } from "./types.js";
import { TaskRegistry } from "./registry.js";

export type DispatchRoute={sessionId?:string;sessionFile?:string;currentSessionId:()=>string|undefined;currentSessionFile:()=>string|undefined};
type Pending={record:TaskRecord;lines?:string[];terminal:boolean;finalEvent?:boolean;retries?:number};
export class Dispatcher {
 private pending:Pending[]=[];private timer?:NodeJS.Timeout;private flushing:Promise<void>=Promise.resolve();private closed=false;
 constructor(private pi:Pick<ExtensionAPI,"sendMessage">,private registry:TaskRegistry,private route:DispatchRoute){}
 setRoute(route:DispatchRoute){this.route=route;}
 event(r:TaskRecord,lines:string[]){if(this.closed||!acceptsRunningEvent(r))return;this.pending.push({record:r,lines:lines.slice(0,20),terminal:false});this.schedule();}
 terminal(r:TaskRecord,preserveRunningEvents=false){if(this.closed||r.notification_suppressed_reason)return;if(preserveRunningEvents)this.pending=this.pending.map(p=>p.record.task_id===r.task_id&&!p.terminal?{...p,finalEvent:true}:p);else this.pending=this.pending.filter(p=>p.record.task_id!==r.task_id);this.pending.push({record:r,terminal:true});this.schedule(10);}
 flush():Promise<void>{if(this.timer)clearTimeout(this.timer);this.timer=undefined;this.flushing=this.flushing.then(()=>this.flushOnce()).catch(e=>console.warn(`task-plane dispatch flush failed: ${message(e)}`));return this.flushing;}
 private async flushOnce():Promise<void>{
  if(!this.pending.length||this.closed)return;const batch=this.pending.splice(0);const accepted:Pending[]=[];
  for(const p of batch){let r:TaskRecord|undefined;try{r=this.registry.get(p.record.task_id);}catch(error){this.retryPreclaim(p,error);continue;}if(!r||r.notification_suppressed_reason||!this.routeMatches(r))continue;
   if(p.terminal){if(!isDispatchableTerminal(r))continue;try{if(!this.registry.claimTerminal(r.task_id,r.owner_session_id))continue;r=this.registry.get(r.task_id)!;}catch(error){this.retryPreclaim(p,error);continue;}accepted.push({record:r,terminal:true});}
   else if(acceptsRunningEvent(r)||p.finalEvent&&isDispatchableTerminal(r)&&acceptsRunningEvent(p.record))accepted.push({record:p.record,lines:p.lines,terminal:false,finalEvent:p.finalEvent});
  }
  if(!accepted.length)return;const content=accepted.map(p=>envelope(p.record,p.lines)).join("\n");
  try{await this.pi.sendMessage({customType:"task-notification",content,display:true,details:{tasks:accepted.map(p=>p.record.task_id)}},{deliverAs:"followUp",triggerTurn:true});}
  catch(e){for(const p of accepted)if(p.terminal)this.persistDispatchFailure(p.record,e);return;}
  for(const p of accepted)if(p.terminal){const current=this.registry.get(p.record.task_id);if(!current||current.dispatch_state!=="dispatch_requested")continue;try{this.registry.updateDispatch(current.task_id,current.owner_session_id,current.record_version,"host_api_invoked");}catch{console.warn(`task-plane post-dispatch persistence failed for ${p.record.task_id}`);}}
 }
 private persistDispatchFailure(record:TaskRecord,error:unknown):void{const current=this.registry.get(record.task_id);if(!current||current.dispatch_state!=="dispatch_requested")return;try{this.registry.updateDispatch(current.task_id,current.owner_session_id,current.record_version,"dispatch_sync_failed",new Date(),message(error));}catch(e){console.warn(`task-plane dispatch failure persistence failed for ${record.task_id}: ${message(e)}`);}}
 private routeMatches(r:TaskRecord):boolean{if(r.owner_session_id!==this.route.sessionId||this.route.currentSessionId()!==r.owner_session_id)return false;const fs=[r.owner_session_file,this.route.sessionFile,this.route.currentSessionFile()];return fs.every(x=>x===undefined)||(fs.every(x=>typeof x==="string")&&new Set(fs).size===1);}
 private retryPreclaim(p:Pending,error:unknown):void{if(this.closed)return;const retries=(p.retries??0)+1;this.pending.push({...p,retries});const delay=Math.min(1_000,10*2**Math.min(retries,7));console.warn(`task-plane dispatch pre-claim failed for ${p.record.task_id}; retrying: ${message(error)}`);this.schedule(delay);}
 shutdown(){if(this.timer)clearTimeout(this.timer);this.timer=undefined;this.pending=[];}
 close(){this.shutdown();this.closed=true;}
 private schedule(delay=0){if(!this.timer){this.timer=setTimeout(()=>void this.flush(),delay);this.timer.unref?.();}}
}
function acceptsRunningEvent(r:TaskRecord){return r.status==="running"&&!r.suspension_pending&&!r.suspended_at&&r.attempt_phase!=="suspended";}
function isDispatchableTerminal(r:TaskRecord){return ["completed","failed","stopped","timed_out"].includes(r.status);}
function message(e:unknown){return e instanceof Error?e.message:String(e);}
function esc(v:unknown){return String(v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
export function envelope(r:TaskRecord,lines?:string[]){const x=(k:string,v:unknown)=>`  <${k}>${esc(v)}</${k}>`;return ["<task_notification not_user_input=\"true\">",x("task_id",r.task_id),x("type",r.type),x("status",r.status),x("output_path",r.output_path),...(r.exit_code!==undefined?[x("exit_code",r.exit_code)]:[]),...(r.signal?[x("signal",r.signal)]:[]),...(r.stop_reason?[x("stop_reason",r.stop_reason)]:[]),...(r.failure_reason?[x("failure_reason",r.failure_reason)]:[]),...(r.status==="running"&&lines?.length?[x("lines",lines.join("\n"))]:[]),"</task_notification>"].join("\n");}
