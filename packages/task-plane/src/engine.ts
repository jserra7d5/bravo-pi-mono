import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { renderClock, type RenderClock } from "@bravo/render-clock";
import { Dispatcher } from "./dispatcher.js";
import { nodeOutputFs, OutputWriter, type OutputFsPort } from "./output.js";
import { SupervisedProcess, type SupervisedClose } from "./process-tree.js";
import { isTerminal, TaskRegistry } from "./registry.js";
import type { StopReason, TaskRecord, TerminalTaskStatus } from "./types.js";

const LEASE_MS = 10_000;
const TICK_MS = 1_000;
const INTERACTIVE_IDLE_MS = 750;
const INTERACTIVE_GRACE_MS = 1_500;
const INTERVAL_STDOUT_BUDGET = 5*1024*1024;
const STOP_TERMINAL_PERSIST_TIMEOUT_MS = 2_000;

type Live = {
  record:TaskRecord; dispatcher: Dispatcher; process?: SupervisedProcess; writer?: OutputWriter; token?: string;
  stopping?: StopReason; suspending?: boolean; shutdown?:boolean; commandTimedOut?:boolean; outputFailed?: Error; finalized?: boolean;
  maxTimer?: NodeJS.Timeout; promptTimer?: NodeJS.Timeout; promptStopTimer?: NodeJS.Timeout;
  leaseRenewedAt?:number; rawStdoutPartial?:boolean;
};
type PendingStreamClaim={record:TaskRecord;dispatcher:Dispatcher;timer?:NodeJS.Timeout};

export interface TaskEngineOptions { runtimeId?: string; schedulerConcurrency?: number; tickMs?: number; renderClock?: RenderClock; outputFs?: OutputFsPort; stdioDrainTimeoutMs?:number }

export class TaskRouteError extends Error { constructor(message:string){super(message);this.name="TaskRouteError";} }

/** Process ownership is deliberately per engine instance, never module-global. */
export class TaskEngine {
  readonly runtimeId: string;
  private live = new Map<string, Live>();
  private sessions = new Map<string, (record: TaskRecord) => Dispatcher>();
  private unsubscribePeriodic?: () => void;
  private periodicGeneration=0;
  private periodicTickInFlight?: {generation:number;promise:Promise<void>};
  private polling = new Set<string>();
  private streamClaims = new Map<string,PendingStreamClaim>();
  private readonly concurrency: number;
  private readonly tickMs: number;
  private readonly clock: RenderClock;
  private readonly periodicSubscriberId: string;
  private readonly outputFs: OutputFsPort;
  private readonly stdioDrainTimeoutMs:number;
  private claimsEnabled=true;

  constructor(readonly registry: TaskRegistry, options: TaskEngineOptions = {}) {
    this.runtimeId = options.runtimeId ?? `${process.pid}:${Date.now()}:${randomBytes(8).toString("hex")}`;
    this.concurrency = options.schedulerConcurrency ?? 4;
    this.tickMs = options.tickMs ?? TICK_MS;
    this.clock = options.renderClock ?? renderClock;
    this.periodicSubscriberId = `task-plane-engine:${this.runtimeId}:${randomBytes(8).toString("hex")}`;
    this.outputFs = options.outputFs ?? nodeOutputFs;
    this.stdioDrainTimeoutMs=options.stdioDrainTimeoutMs??5_000;
  }

  startBash(input: {command:string;cwd:string;timeout_s:number;owner_session_id:string;owner_session_file?:string}, dispatcher: Dispatcher): TaskRecord {
    const record = this.registry.admit(input.owner_session_id, { type:"bash", command:input.command, cwd:input.cwd,
      owner_session_id:input.owner_session_id, owner_session_file:input.owner_session_file, max_output_bytes:10*1024*1024,
      max_runtime_s:input.timeout_s, started_at:new Date().toISOString() }).record;
    this.spawnStream(record, dispatcher);
    return record;
  }

  startMonitor(input: {command:string;name?:string;cwd:string;interval_s?:number;until_output_matches?:string;lifespan_s?:number;command_timeout_s?:number;idempotency_key?:string;owner_session_id:string;owner_session_file?:string}, dispatcher: Dispatcher) {
    const now = new Date(); const mode = input.interval_s === undefined ? "stream" : "interval";
    const admitted = this.registry.admit(input.owner_session_id, { type:"monitor", mode, name:input.name, command:input.command,
      cwd:input.cwd, started_at:now.toISOString(), deadline_at:input.lifespan_s ? new Date(now.getTime()+input.lifespan_s*1000).toISOString() : undefined,
      owner_session_id:input.owner_session_id, owner_session_file:input.owner_session_file, max_output_bytes:5*1024*1024,
      interval_s:input.interval_s, until_output_matches:input.until_output_matches, command_timeout_s:input.command_timeout_s,
      idempotency_key:input.idempotency_key });
    if (!admitted.idempotent) {
      this.enableScheduler(admitted.record.owner_session_id, () => dispatcher);
      if (mode === "stream") this.claimAndSpawnStream(admitted.record, dispatcher);
    }
    return { ...admitted.record, idempotent: admitted.idempotent };
  }

  private claimAndSpawnStream(record: TaskRecord, dispatcher: Dispatcher): void {
    let pending=this.streamClaims.get(record.task_id);if(!pending){pending={record,dispatcher};this.streamClaims.set(record.task_id,pending);}
    if(!this.claimsEnabled)return;
    try{const current=this.registry.get(record.task_id);if(!current||isTerminal(current.status)||current.status==="orphaned"||current.suspension_pending){this.clearPendingStreamClaim(record.task_id);return;}const claim = this.registry.claimLease(current.task_id, current.owner_session_id, current.record_version, this.runtimeId, LEASE_MS);if(claim.outcome!=="acquired"){this.clearPendingStreamClaim(record.task_id);return;}this.clearPendingStreamClaim(record.task_id);if(!this.claimsEnabled){const requested=this.registry.requestSuspension(claim.record.task_id,claim.record.owner_session_id,claim.record.record_version);this.registry.suspendClaimed(requested.task_id,requested.owner_session_id,requested.record_version,claim.record.lease_token!);return;}this.spawnStream(claim.record, dispatcher, claim.record.lease_token);}
    catch(error){if(this.streamClaims.get(record.task_id)!==pending)throw error;if(!this.claimsEnabled)return;console.warn(`task-plane stream claim failed for ${record.task_id}; retrying: ${asError(error).message}`);pending.timer=setTimeout(()=>{pending!.timer=undefined;this.claimAndSpawnStream(record,dispatcher);},25);pending.timer.unref?.();}
  }
  private clearPendingStreamClaim(id:string):void{const pending=this.streamClaims.get(id);if(pending?.timer)clearTimeout(pending.timer);this.streamClaims.delete(id);}
  private async suspendPendingStreamClaim(pending:PendingStreamClaim):Promise<void>{if(pending.timer)clearTimeout(pending.timer);pending.dispatcher.shutdown();const deadline=Date.now()+STOP_TERMINAL_PERSIST_TIMEOUT_MS;let lastError:Error|undefined;while(Date.now()<deadline){try{let current=this.registry.get(pending.record.task_id);if(!current||isTerminal(current.status)||current.status==="orphaned"){this.streamClaims.delete(pending.record.task_id);return;}if(!current.suspension_pending)current=this.registry.requestSuspension(current.task_id,current.owner_session_id,current.record_version);if(current.attempt_phase!=="suspended"&&!current.lease_token)this.registry.suspend(current.task_id,current.owner_session_id,current.record_version);this.streamClaims.delete(pending.record.task_id);return;}catch(error){lastError=asError(error);await new Promise(resolve=>setTimeout(resolve,25));}}throw new Error(`Task ${pending.record.task_id} was not durably suspended within ${STOP_TERMINAL_PERSIST_TIMEOUT_MS}ms${lastError?`: ${lastError.message}`:"."}`);}

  private spawnStream(record: TaskRecord, dispatcher: Dispatcher, token?: string): void {
    let writer: OutputWriter;
    try { writer = new OutputWriter(record.output_path, record.type, record.max_output_bytes, this.outputFs, record.output_bytes); }
    catch(error) { this.failSynchronousStart(record,dispatcher,token,asError(error)); }
    const live: Live = { record:{...record}, dispatcher, writer, token };
    this.live.set(record.task_id, live);this.armControl(record.task_id);
    live.process = new SupervisedProcess({ command:record.command, cwd:record.cwd,
      onSpawn:(pid,pgid) => this.onSpawn(record.task_id,pid,pgid),
      onData:(source,data) => this.onData(record.task_id,source,data),
      onClose:result => this.onStreamClose(record.task_id,result),
      onCallbackError:error => this.onExecutionError(record.task_id,error),stdioDrainTimeoutMs:this.stdioDrainTimeoutMs,
    });
    if (record.type === "bash" && record.max_runtime_s) {
      live.maxTimer = setTimeout(() => this.requestStop(record.task_id,"timeout"), record.max_runtime_s*1000); live.maxTimer.unref?.();
    }
    if (token) this.armLease(record.task_id);
  }

  private onSpawn(id:string,pid:number,pgid?:number): void {
    const live=this.live.get(id), r=this.registry.get(id); if(!live||!r)return;
    try {
      if (live.token) this.registry.updateAttemptClaimed(id,r.owner_session_id,r.record_version,live.token,{pid,pgid});
      else this.registry.attachProcess(id,r.owner_session_id,r.record_version,this.runtimeId,pid,pgid);
    } catch (error) { this.onExecutionError(id, asError(error)); }
  }

  private onData(id:string,source:"stdout"|"stderr",data:Buffer): void {
    const live=this.live.get(id), r=this.registry.get(id); if(!live||!r||!live.writer)return;
    try {
      const result=live.writer.write(source,data);
      this.commitOutput(r,live,live.writer.bytes);
      if(r.type==="monitor"&&source==="stdout")this.countRawStdout(id,data);
      if(r.type==="bash"&&result.capped)this.requestStop(id,"output_cap");
      this.armPromptDetection(id);
    } catch(error) { this.onExecutionError(id,asError(error)); }
  }

  private commitOutput(record:TaskRecord,live:Live,bytes:number):void {
    const latest=this.registry.get(record.task_id);if(!latest||isTerminal(latest.status))return;
    if(live.token)this.registry.updateAttemptClaimed(latest.task_id,latest.owner_session_id,latest.record_version,live.token,{output_bytes:bytes});
    else this.registry.updateOutput(latest.task_id,latest.owner_session_id,latest.record_version,bytes);
  }

  private onStreamClose(id:string,result:SupervisedClose):void {
    const live=this.live.get(id); if(!live)return;
    this.clearTimer(live.promptTimer);this.clearTimer(live.promptStopTimer);
    try {
      for(const partial of live.writer?.flushPartials()??[])if(partial.source==="stdout"&&live.rawStdoutPartial&&this.countFlood(id))this.requestStop(id,"event_flood");live.rawStdoutPartial=false;
      const current=this.registry.get(id);if(current&&live.writer)this.commitOutput(current,live,live.writer.bytes);
      live.writer?.close();
    } catch(error){live.outputFailed=asError(error);}
    if(live.suspending){const current=this.registry.get(id);if(current)try{live.token?this.registry.suspendClaimed(id,current.owner_session_id,current.record_version,live.token):this.registry.suspend(id,current.owner_session_id,current.record_version);}catch{setTimeout(()=>this.onStreamClose(id,result),25).unref?.();return;}this.cleanup(id);return;}
    const reason=live.stopping;
    const status:TerminalTaskStatus=live.outputFailed||result.spawnError?"failed":reason==="timeout"?"timed_out":reason?"stopped":result.code===0?"completed":"failed";
    this.finish(id,status,live.dispatcher,result.code,result.signal,reason,live.token,result.stdioDrainTimedOut,live.shutdown);
  }

  private onExecutionError(id:string,error:Error):void {
    const live=this.live.get(id);if(!live||live.outputFailed)return;live.outputFailed=error;
    if(live.process?.pid)void live.process.terminate("SIGTERM",1_000).catch(()=>{});else this.finish(id,"failed",live.dispatcher,undefined,undefined,undefined,live.token);
  }

  private armPromptDetection(id:string):void {
    const live=this.live.get(id),r=this.registry.get(id);if(!live||!r||r.type!=="bash")return;
    this.clearTimer(live.promptTimer);
    live.promptTimer=setTimeout(()=>{
      const current=this.registry.get(id),l=this.live.get(id);if(!current||!l||l.stopping||isTerminal(current.status))return;
      // Shell programs conventionally print password/confirmation prompts without a newline.
      const tail=`${l.writer?.pendingText("stdout")??""}\n${l.writer?.pendingText("stderr")??""}`;
      if(!/(?:password|passphrase|enter pin|\[(?:y\/n|Y\/n|y\/N)\])\s*[:?]?\s*$/i.test(tail))return;
      try{this.registry.setBlocked(id,current.owner_session_id,current.record_version,true,"interactive prompt detected; stdin is unavailable");}catch{return;}
      l.promptStopTimer=setTimeout(()=>this.requestStop(id,"interactive_prompt"),INTERACTIVE_GRACE_MS);l.promptStopTimer.unref?.();
    },INTERACTIVE_IDLE_MS);live.promptTimer.unref?.();
  }

  private countRawStdout(id:string,data:Buffer):void{const live=this.live.get(id);if(!live)return;for(const byte of data)if(byte===10){live.rawStdoutPartial=false;if(this.countFlood(id))this.requestStop(id,"event_flood");}else live.rawStdoutPartial=true;}
  private countFlood(id:string):boolean {const live=this.live.get(id);if(!live?.token)return false;try{const current=this.registry.get(id);if(!current||isTerminal(current.status)||current.lease_token!==live.token)return false;return this.registry.appendEventTimestamp(id,current.owner_session_id,current.record_version,live.token).count>300;}catch(error){this.onExecutionError(id,asError(error));return false;}}

  private enableScheduler(session:string,makeDispatcher:(record:TaskRecord)=>Dispatcher):void {
    this.sessions.set(session,makeDispatcher);this.ensurePeriodicSubscriber();
  }
  private ensurePeriodicSubscriber():void {
    if(this.unsubscribePeriodic)return;
    const generation=++this.periodicGeneration;
    this.unsubscribePeriodic=this.clock.subscribe({
      id:this.periodicSubscriberId,
      intervalMs:this.tickMs,
      reconcile:()=>this.reconcilePeriodic(generation),
    });
    queueMicrotask(()=>{void this.reconcilePeriodic(generation);});
  }
  private reconcilePeriodic(generation:number):Promise<void> {
    if(generation!==this.periodicGeneration)return Promise.resolve();
    if(this.periodicTickInFlight?.generation===generation)return this.periodicTickInFlight.promise;
    const running=this.safePeriodicTick(generation).finally(()=>{if(this.periodicTickInFlight?.promise===running)this.periodicTickInFlight=undefined;});
    this.periodicTickInFlight={generation,promise:running};
    return running;
  }
  private async safePeriodicTick(generation:number):Promise<void> {
    if(generation!==this.periodicGeneration)return;
    try{this.periodicTick();}
    catch(error){
      if(!existsSync(this.registry.tasksDir)){this.stopPeriodicSubscriber();return;}
      console.warn(`task-plane scheduler tick failed: ${asError(error).message}`);
    }
    if(generation===this.periodicGeneration)this.stopSchedulerIfIdle();
  }
  private periodicTick():void {
    this.consumeStopRequests();this.renewLeases();if(!this.claimsEnabled)return;this.sweepLifespans();this.sweepExpiredAttempts();let slots=this.concurrency-this.polling.size;if(slots<=0)return;
    for(const [session,make] of this.sessions){if(slots<=0)break;const claimed=this.registry.claimDue(session,this.runtimeId,slots,LEASE_MS);
      for(const r of claimed){slots--;this.polling.add(r.task_id);void this.runPoll(r,make(r)).finally(()=>{this.polling.delete(r.task_id);this.stopSchedulerIfIdle();});}
    }
  }
  private stopSchedulerIfIdle():void {
    if(!this.unsubscribePeriodic||this.live.size||this.polling.size||this.streamClaims.size)return;
    try{if(this.registry.list(false).some(r=>r.type==="monitor"&&this.sessions.has(r.owner_session_id)&&!isTerminal(r.status)&&r.status!=="orphaned"))return;}
    catch(error){if(!existsSync(this.registry.tasksDir))this.stopPeriodicSubscriber();else console.warn(`task-plane scheduler idle check failed: ${asError(error).message}`);return;}
    this.stopPeriodicSubscriber();
  }
  private stopPeriodicSubscriber():void {this.periodicGeneration++;const unsubscribe=this.unsubscribePeriodic;this.unsubscribePeriodic=undefined;unsubscribe?.();}

  private async runPoll(record:TaskRecord,dispatcher:Dispatcher):Promise<void>{
    let writer:OutputWriter;try{writer=new OutputWriter(record.output_path,"monitor",record.max_output_bytes,this.outputFs,record.output_bytes);writer.frame(`poll started attempt ${record.attempt??1}`);}catch{this.finish(record.task_id,"failed",dispatcher,undefined,undefined,undefined,record.lease_token);return;}
    const live:Live={record:{...record},dispatcher,writer,token:record.lease_token};this.live.set(record.task_id,live);this.armControl(record.task_id);let stdout="",stdoutBytes=0,overflow=false;const decoder=new StringDecoder("utf8");
    const result=await new Promise<SupervisedClose>(resolve=>{
      live.process=new SupervisedProcess({command:record.command,cwd:record.cwd,onSpawn:(pid,pgid)=>this.onSpawn(record.task_id,pid,pgid),onData:(source,data)=>{
        try{writer.write(source,data);this.commitOutput(record,live,writer.bytes);if(source==="stdout"){this.countRawStdout(record.task_id,data);stdoutBytes+=data.length;if(stdoutBytes>INTERVAL_STDOUT_BUDGET){overflow=true;writer.frame("interval stdout exceeded 5242880-byte budget; observer failed");void live.process?.terminate("SIGKILL",0);}else stdout+=decoder.write(data);}}catch(error){this.onExecutionError(record.task_id,asError(error));}
      },onClose:resolve,onCallbackError:error=>this.onExecutionError(record.task_id,error),stdioDrainTimeoutMs:this.stdioDrainTimeoutMs});
      if(record.command_timeout_s){live.maxTimer=setTimeout(()=>{if(live.commandTimedOut||live.outputFailed||overflow||live.stopping||live.suspending)return;live.commandTimedOut=true;live.outputFailed=new Error("command_timeout");void live.process?.terminate("SIGKILL",0).catch(error=>this.onExecutionError(record.task_id,asError(error)));},record.command_timeout_s*1000);live.maxTimer.unref?.();}
      this.armLease(record.task_id);
    });
    this.clearTimer(live.maxTimer);if(!overflow)stdout+=decoder.end();try{writer.flushPartials();if(live.rawStdoutPartial&&this.countFlood(record.task_id))this.requestStop(record.task_id,"event_flood");live.rawStdoutPartial=false;writer.frame(`poll exit=${result.code??"null"}${live.commandTimedOut?" command_timeout":""}`);writer.close();}catch(error){live.outputFailed=asError(error);}
    const latest=this.registry.get(record.task_id);if(!latest||isTerminal(latest.status)||latest.status==="orphaned"||latest.lease_token!==record.lease_token){this.cleanup(record.task_id);return;}
    if(live.commandTimedOut){this.finish(record.task_id,"failed",dispatcher,result.code,result.signal,undefined,record.lease_token,result.stdioDrainTimedOut,live.shutdown);return;}
    if(live.suspending||latest.suspension_pending){this.completeSuspension(record.task_id,record.lease_token!);return;}
    if(live.stopping){this.finish(record.task_id,live.stopping==="timeout"?"timed_out":"stopped",dispatcher,result.code,result.signal,live.stopping,record.lease_token);return;}
    // Flood accounting happens incrementally on every decoded raw stdout line,
    // before batching, repetition suppression, output-budget, and natural poll
    // outcomes. A flood stop therefore participates in the normal first-
    // terminalizer decision above.
    const hash=createHash("sha256").update(String(result.code)).update("\0").update(stdout).digest("hex");
    if(live.outputFailed||overflow||result.spawnError||result.code!==0){this.finish(record.task_id,"failed",dispatcher,result.code,result.signal,undefined,record.lease_token);return;}
    if(record.until_output_matches&&new RegExp(record.until_output_matches).test(stdout)){this.finish(record.task_id,"completed",dispatcher,result.code,result.signal,undefined,record.lease_token);return;}
    if(record.deadline_at&&Date.now()>=Date.parse(record.deadline_at)){this.finish(record.task_id,"timed_out",dispatcher,result.code,result.signal,"timeout",record.lease_token);return;}
    this.completePollSchedule(record,hash,result);
  }

  private completePollSchedule(record:TaskRecord,hash:string,result:SupervisedClose):void {
    const id=record.task_id,token=record.lease_token!,live=this.live.get(id);if(!live)return;
    try{let current=this.registry.get(id);if(!current||isTerminal(current.status)||current.status==="orphaned"||current.lease_token!==token){this.cleanup(id);return;}if(current.suspension_pending||live.suspending){this.completeSuspension(id,token);return;}if(live.stopping){this.finish(id,live.stopping==="timeout"?"timed_out":"stopped",live.dispatcher,result.code,result.signal,live.stopping,token);return;}
      const nextRunAt=new Date(Date.now()+(record.interval_s??5)*1000).toISOString();
      current=this.registry.commitScheduleClaimed(id,current.owner_session_id,current.record_version,token,nextRunAt,hash);
      this.registry.releaseLease(id,current.owner_session_id,current.record_version,token);this.cleanup(id);
    }catch(error){if(this.reconcileExpired(id,token))return;console.warn(`task-plane failed to persist poll schedule ${id}: ${asError(error).message}`);setTimeout(()=>this.completePollSchedule(record,hash,result),25).unref?.();}
  }

  private consumeStopRequests():void {for(const id of this.live.keys())this.consumeStopRequest(id);}
  private consumeStopRequest(id:string):void{const l=this.live.get(id),r=this.registry.get(id);if(!l||!r||!r.stop_requested_at||r.stop_acknowledged_at||l.commandTimedOut||l.stopping)return;try{const ack=this.registry.acknowledgeStop(id,r.owner_session_id,r.record_version,this.runtimeId);l.stopping=ack.stop_requested_reason;void l.process?.terminate(ack.stop_requested_signal,(ack.stop_requested_kill_after_s??5)*1000);}catch{}}
  private sweepExpiredAttempts():void{for(const session of this.sessions.keys())try{this.registry.orphanExpiredAttempts(session,new Date(),new Set(this.live.keys()));}catch(error){console.warn(`task-plane expired-attempt sweep failed: ${asError(error).message}`);}}
  private armControl(_id:string):void{this.ensurePeriodicSubscriber();}
  private sweepLifespans():void {for(const r of this.registry.list(false)){if(r.type!=="monitor"||!r.deadline_at||Date.now()<Date.parse(r.deadline_at))continue;const live=this.live.get(r.task_id);if(live){this.requestStop(r.task_id,"timeout");continue;}const make=this.sessions.get(r.owner_session_id);if(!make)continue;try{if(r.owner_runtime_id){if(!r.stop_requested_at)this.registry.requestStop(r.task_id,r.owner_session_id,r.record_version,"timeout");continue;}const expired=this.registry.expireMonitorLifespan(r.task_id,r.owner_session_id,r.record_version);make(expired).terminal(expired);}catch{}}}
  private armLease(id:string):void {const l=this.live.get(id);if(!l?.token)return;l.leaseRenewedAt=this.clock.now();this.ensurePeriodicSubscriber();}
  private renewLeases():void {for(const [id,l] of this.live){if(!l.token||this.clock.now()-(l.leaseRenewedAt??0)<Math.min(this.tickMs,LEASE_MS/2))continue;let current:TaskRecord|undefined;try{current=this.registry.get(id);if(!current||isTerminal(current.status)||current.status==="orphaned")continue;if(current.lease_token!==l.token){void l.process?.terminate("SIGKILL",0).catch(()=>{});continue;}if(current.stop_requested_at&&!current.stop_acknowledged_at&&current.owner_runtime_id===this.runtimeId&&!l.commandTimedOut&&!l.stopping){const ack=this.registry.acknowledgeStop(id,current.owner_session_id,current.record_version,this.runtimeId);l.stopping=current.stop_requested_reason;void l.process?.terminate(current.stop_requested_signal,(ack.stop_requested_kill_after_s??5)*1000);continue;}this.registry.renewLease(id,current.owner_session_id,current.record_version,l.token,LEASE_MS);l.leaseRenewedAt=this.clock.now();}catch{if(this.reconcileExpired(id,l.token))void l.process?.terminate("SIGKILL",0).catch(()=>{});/* failures before expiry are retried */}}}

  async stop(id:string,signal:"SIGTERM"|"SIGKILL"="SIGTERM",killAfter=5):Promise<TaskRecord|undefined>{
    let r=this.registry.get(id);if(!r)return r;if(r.status==="orphaned")throw new TaskRouteError("Orphaned task has no verifiable process owner.");if(isTerminal(r.status))return r;const live=this.live.get(id);
    if(!live&&r.type==="monitor"&&r.mode==="interval"&&!r.lease_token){const make=this.sessions.get(r.owner_session_id);if(make){this.finish(id,"stopped",make(r),undefined,undefined,"user");return this.awaitTerminalPersistence(id);}return this.registry.get(id);}
    if(!live||r.owner_runtime_id&&r.owner_runtime_id!==this.runtimeId){r=this.registry.requestStop(id,r.owner_session_id,r.record_version,"user",signal,new Date(),killAfter);const ackGrace=Math.max(100,Math.min(2_000,this.tickMs+50)),ackDeadline=Date.now()+ackGrace;let acknowledged=false;while(Date.now()<ackDeadline){await new Promise(resolve=>setTimeout(resolve,Math.min(25,Math.max(1,ackDeadline-Date.now()))));const current=this.registry.get(id);if(!current||isTerminal(current.status))return current;if(current.status==="orphaned")throw new TaskRouteError("Task owner became unverifiable while stopping.");if(current.stop_acknowledged_at){r=current;acknowledged=true;break;}}if(acknowledged){const closeDeadline=Date.now()+(r.stop_requested_kill_after_s??killAfter)*1000+this.stdioDrainTimeoutMs+1_000;while(Date.now()<closeDeadline){await new Promise(resolve=>setTimeout(resolve,25));const current=this.registry.get(id);if(!current||isTerminal(current.status))return current;if(current.status==="orphaned")throw new TaskRouteError("Task owner became unverifiable while stopping.");}throw new Error("Task owner acknowledged stop but process did not close after escalation and stdio drain.");}const current=this.registry.get(id);if(current&&!isTerminal(current.status)&&current.lease_expires_at&&Date.parse(current.lease_expires_at)<=Date.now())try{this.registry.markOrphaned(id,current.owner_session_id,current.record_version,"stop_owner_unresponsive");}catch{}throw new TaskRouteError("Task owner did not acknowledge stop within the owner control grace.");}
    if(live.commandTimedOut||live.stopping){if(live.process)await live.process.terminate(signal,killAfter*1000);return this.awaitTerminalPersistence(id);}
    try{r=this.registry.requestStop(id,r.owner_session_id,r.record_version,"user",signal,new Date(),killAfter);r=this.registry.acknowledgeStop(id,r.owner_session_id,r.record_version,this.runtimeId);}catch{}live.stopping="user";if(live.process)await live.process.terminate(signal,killAfter*1000);else this.finish(id,"stopped",live.dispatcher,undefined,undefined,"user",live.token);return this.awaitTerminalPersistence(id);
  }
  private async awaitTerminalPersistence(id:string):Promise<TaskRecord|undefined>{const deadline=Date.now()+STOP_TERMINAL_PERSIST_TIMEOUT_MS;let lastError:Error|undefined;while(Date.now()<deadline){try{const current=this.registry.get(id);if(!current||isTerminal(current.status)||current.status==="orphaned")return current;}catch(error){lastError=asError(error);}await new Promise(resolve=>setTimeout(resolve,25));}throw new Error(`Task ${id} process closed but terminal metadata was not durably persisted within ${STOP_TERMINAL_PERSIST_TIMEOUT_MS}ms${lastError?`: ${lastError.message}`:"."}`);}
  private async awaitSuspensionPersistence(id:string):Promise<TaskRecord|undefined>{const deadline=Date.now()+STOP_TERMINAL_PERSIST_TIMEOUT_MS;let lastError:Error|undefined;while(Date.now()<deadline){try{const current=this.registry.get(id);if(!current||isTerminal(current.status))return current;if(current.attempt_phase==="suspended"&&!current.pid&&!current.pgid&&!current.owner_runtime_id&&!current.lease_token)return current;if(current.status==="orphaned")throw new Error(`Task ${id} became orphaned instead of suspended.`);}catch(error){lastError=asError(error);}await new Promise(resolve=>setTimeout(resolve,25));}throw new Error(`Task ${id} process closed but suspended metadata was not durably persisted within ${STOP_TERMINAL_PERSIST_TIMEOUT_MS}ms${lastError?`: ${lastError.message}`:"."}`);}
  private async suspendInactiveMonitor(id:string):Promise<TaskRecord|undefined>{const deadline=Date.now()+STOP_TERMINAL_PERSIST_TIMEOUT_MS;let lastError:Error|undefined;while(Date.now()<deadline){try{let current=this.registry.get(id);if(!current||isTerminal(current.status))return current;if(current.attempt_phase==="suspended"&&!current.pid&&!current.pgid&&!current.owner_runtime_id&&!current.lease_token)return current;if(current.status==="orphaned")throw new Error(`Task ${id} became orphaned instead of suspended.`);if(!current.suspension_pending)current=this.registry.requestSuspension(current.task_id,current.owner_session_id,current.record_version);if(current.attempt_phase!=="suspended"&&!current.lease_token)this.registry.suspend(current.task_id,current.owner_session_id,current.record_version);}catch(error){lastError=asError(error);}await new Promise(resolve=>setTimeout(resolve,25));}throw new Error(`Task ${id} was not durably suspended within ${STOP_TERMINAL_PERSIST_TIMEOUT_MS}ms${lastError?`: ${lastError.message}`:"."}`);}
  private requestStop(id:string,reason:StopReason):void {const l=this.live.get(id);if(!l||l.commandTimedOut||l.stopping||l.suspending)return;l.stopping=reason;if(l.process?.pid)void l.process.terminate("SIGTERM",1_000).catch(error=>this.onExecutionError(id,asError(error)));else this.finish(id,reason==="timeout"?"timed_out":"stopped",l.dispatcher,undefined,undefined,reason,l.token);}

  private failSynchronousStart(record:TaskRecord,dispatcher:Dispatcher,token: string|undefined,error:Error):never {
    const current=this.registry.get(record.task_id);if(!current||isTerminal(current.status)||current.status==="orphaned"||token&&current.lease_token!==token)throw error;
    const failed=token?this.registry.finalizeClaimed(current.task_id,current.owner_session_id,current.record_version,token,"failed"):this.registry.finalizeUnleased(current.task_id,current.owner_session_id,current.record_version,"failed");
    dispatcher.terminal(failed);
    throw error;
  }
  private finish(id:string,status:TerminalTaskStatus,dispatcher:Dispatcher,code?:number,signal?:string,reason?:StopReason,token?:string,stdioDrainTimedOut?:boolean,suppressShutdown=false):void {
    const live=this.live.get(id);try{const r=this.registry.get(id);if(!r||isTerminal(r.status)||r.status==="orphaned"||live?.finalized){this.cleanup(id);return;}if(token&&r.lease_token!==token){this.cleanup(id);return;}const patch={exit_code:code!==undefined&&code>=0?code:undefined,signal,stop_reason:reason,stdio_drain_timed_out:stdioDrainTimedOut||undefined,notification_suppressed_reason:suppressShutdown?"shutdown" as const:undefined,failure_reason:live?.commandTimedOut||live?.outputFailed?.message==="command_timeout"?"command_timeout" as const:undefined};const next=token?this.registry.finalizeClaimed(id,r.owner_session_id,r.record_version,token,status,patch):this.registry.finalizeUnleased(id,r.owner_session_id,r.record_version,status,patch);if(live)live.finalized=true;this.cleanup(id);if(!suppressShutdown)dispatcher.terminal(next);}catch(error){if(token&&this.reconcileExpired(id,token))return;console.warn(`task-plane failed to finalize ${id}: ${asError(error).message}`);setTimeout(()=>this.finish(id,status,dispatcher,code,signal,reason,token,stdioDrainTimedOut,suppressShutdown),25).unref?.();}
  }
  private completeSuspension(id:string,token:string):void {try{const r=this.registry.get(id);if(!r||isTerminal(r.status)||r.status==="orphaned"||r.lease_token!==token){this.cleanup(id);return;}this.registry.suspendClaimed(id,r.owner_session_id,r.record_version,token);this.cleanup(id);}catch(error){if(this.reconcileExpired(id,token))return;console.warn(`task-plane failed to suspend ${id}: ${asError(error).message}`);setTimeout(()=>this.completeSuspension(id,token),25).unref?.();}}
  private reconcileExpired(id:string,token:string):boolean{let r:TaskRecord|undefined;try{r=this.registry.get(id);}catch{return false;}if(!r||r.lease_token!==token||!r.lease_expires_at||Date.parse(r.lease_expires_at)>Date.now())return false;try{this.registry.markOrphaned(id,r.owner_session_id,r.record_version,"expired_unverified_attempt");}catch{return false;}this.cleanup(id);return true;}
  private cleanup(id:string):void {const l=this.live.get(id);if(l)for(const timer of [l.maxTimer,l.promptTimer,l.promptStopTimer])this.clearTimer(timer);try{l?.writer?.close();}catch{}this.live.delete(id);this.stopSchedulerIfIdle();}

  beginShutdown():void {this.claimsEnabled=false;this.stopSchedulerIfIdle();}
  async shutdown(sessionId?:string):Promise<void>{
    this.beginShutdown();const errors:unknown[]=[],pending=[...this.streamClaims.values()].filter(p=>!sessionId||p.record.owner_session_id===sessionId),pendingIds=new Set(pending.map(p=>p.record.task_id));
    for(const p of pending)if(p.timer){clearTimeout(p.timer);p.timer=undefined;}
    let records:TaskRecord[]=[];try{records=existsSync(this.registry.tasksDir)?this.registry.list(false):[];}catch(error){errors.push(error);}
    const byId=new Map<string,TaskRecord>();
    for(const [id,l] of this.live)if(!pendingIds.has(id)&&(!sessionId||l.record.owner_session_id===sessionId))byId.set(id,l.record);
    for(const r of records)if((!sessionId||r.owner_session_id===sessionId)&&!pendingIds.has(r.task_id)&&!byId.has(r.task_id))byId.set(r.task_id,r);
    const operations:Promise<void>[]=[...pending.map(p=>this.suspendPendingStreamClaim(p)),...[...byId.values()].map(r=>this.shutdownRecord(r))];
    for(const result of await Promise.allSettled(operations))if(result.status==="rejected")errors.push(result.reason);
    if(sessionId)this.sessions.delete(sessionId);else this.sessions.clear();this.stopSchedulerIfIdle();
    if(errors.length===1)throw errors[0];if(errors.length>1)throw new AggregateError(errors,`Task shutdown encountered ${errors.length} failures after attempting all owned tasks.`);
  }
  private async shutdownRecord(r:TaskRecord):Promise<void>{const l=this.live.get(r.task_id);if(!l){if(r.type==="monitor"&&!isTerminal(r.status)&&r.status!=="orphaned"&&!r.lease_token)await this.suspendInactiveMonitor(r.task_id);return;}l.dispatcher.shutdown();if(r.type==="monitor"&&!l.commandTimedOut){l.suspending=true;try{const current=this.registry.get(r.task_id)!;this.registry.requestSuspension(current.task_id,current.owner_session_id,current.record_version);}catch{}if(l.process)await l.process.terminate("SIGTERM",5_000);else if(l.token)this.completeSuspension(r.task_id,l.token);else this.onStreamClose(r.task_id,{});await this.awaitSuspensionPersistence(r.task_id);return;}if(!l.commandTimedOut)l.stopping??="user";l.shutdown=true;const reason=l.stopping,status:TerminalTaskStatus=l.commandTimedOut||l.outputFailed?"failed":reason==="timeout"?"timed_out":"stopped";if(l.process){const result=await l.process.terminate("SIGTERM",5_000);const current=this.registry.get(r.task_id);if(current&&!isTerminal(current.status))this.finish(r.task_id,status,l.dispatcher,result.code,result.signal,reason,l.token,result.stdioDrainTimedOut,true);}else this.finish(r.task_id,status,l.dispatcher,undefined,undefined,reason,l.token,undefined,true);await this.awaitTerminalPersistence(r.task_id);}
  rehydrate(sessionId:string|undefined,makeDispatcher:(r:TaskRecord)=>Dispatcher):void {if(!sessionId)return;this.claimsEnabled=true;this.enableScheduler(sessionId,makeDispatcher);for(const r of this.registry.list(false)){if(r.owner_session_id!==sessionId)continue;if(r.status==="running"&&r.type==="monitor"&&r.mode==="stream"&&r.attempt_phase==="starting"&&!r.owner_runtime_id&&!r.pid&&!r.pgid&&!r.lease_token&&!r.suspension_pending&&!r.stop_requested_at){const d=makeDispatcher(r);let claim;try{claim=this.registry.claimUnstartedStream(r.task_id,r.owner_session_id,r.record_version,this.runtimeId,LEASE_MS);}catch{continue;}if(claim.outcome==="acquired")this.spawnStream(claim.record,d,claim.record.lease_token);else if(claim.outcome==="unclaimable"&&claim.status==="timed_out")d.terminal(claim.record);continue;}if(r.status==="running"&&r.type==="monitor"&&r.attempt_phase==="suspended"){const d=makeDispatcher(r);if(r.deadline_at&&Date.now()>=Date.parse(r.deadline_at)){try{const expired=this.registry.expireSuspendedMonitorLifespan(r.task_id,r.owner_session_id,r.record_version);d.terminal(expired);}catch{}continue;}else{let claim;try{claim=this.registry.resumeAndClaim(r.task_id,r.owner_session_id,r.record_version,this.runtimeId,LEASE_MS);}catch{continue;}if(claim.outcome!=="acquired")continue;const next=claim.record;try{const w=new OutputWriter(next.output_path,"monitor",next.max_output_bytes,this.outputFs,next.output_bytes);w.frame(`rehydrated attempt ${next.attempt}`);w.close();}catch{}if(next.mode==="stream")this.spawnStream(next,d,next.lease_token);else{this.polling.add(next.task_id);void this.runPoll(next,d).finally(()=>this.polling.delete(next.task_id));}}}else if((r.status==="running"||r.status==="blocked")&&r.type==="bash"&&r.owner_runtime_id!==this.runtimeId)this.registry.markOrphaned(r.task_id,r.owner_session_id,r.record_version,"unverified_after_reload");}const backfillDispatchers=new Set<Dispatcher>();for(const candidate of this.registry.dispatchBackfillCandidates(sessionId)){const d=makeDispatcher(candidate);d.terminal(candidate);backfillDispatchers.add(d);}for(const d of backfillDispatchers)void d.flush();}
  private clearTimer(timer:NodeJS.Timeout|undefined):void{if(timer)clearTimeout(timer);}
}
function asError(error:unknown):Error{return error instanceof Error?error:new Error(String(error));}
