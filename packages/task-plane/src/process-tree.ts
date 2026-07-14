import { spawn, type ChildProcess } from "node:child_process";
import { getShellConfig } from "@earendil-works/pi-coding-agent";

export function killProcessTree(pid:number,signal:NodeJS.Signals="SIGTERM"):void{if(!Number.isInteger(pid)||pid<=0)return;if(process.platform!=="win32"){try{process.kill(-pid,signal);}catch{}return;}try{process.kill(pid,signal);}catch{}}
export function processTreeAlive(pid:number):boolean{try{process.kill(process.platform==="win32"?pid:-pid,0);return true;}catch(error){return(error as NodeJS.ErrnoException).code==="EPERM";}}
export async function terminateProcessTree(pid:number,signal:"SIGTERM"|"SIGKILL"="SIGTERM",killAfterMs=5_000):Promise<void>{killProcessTree(pid,signal);if(signal!=="SIGKILL"){const deadline=Date.now()+Math.max(0,killAfterMs);while(processTreeAlive(pid)&&Date.now()<deadline)await delay(20);if(processTreeAlive(pid))killProcessTree(pid,"SIGKILL");}const confirm=Date.now()+1_000;while(processTreeAlive(pid)&&Date.now()<confirm)await delay(20);if(processTreeAlive(pid))throw new Error(`process group ${pid} did not close after SIGKILL`);}

export interface SupervisedClose{code?:number;signal?:NodeJS.Signals;spawnError?:Error;stdioDrainTimedOut?:boolean}
export interface SupervisedProcessOptions{command:string;cwd:string;onSpawn(pid:number,pgid?:number):void;onData(source:"stdout"|"stderr",data:Buffer):void;onClose(result:SupervisedClose):void;onCallbackError(error:Error):void;stdioDrainTimeoutMs?:number}

type TerminationAttempt={promise:Promise<SupervisedClose>};

/** Separates leader exit from descriptor close. A descendant outside the managed
 * group may retain inherited pipes; after the drain allowance we sever only our
 * local readers and finalize from the already observed leader outcome. */
export class SupervisedProcess{
 readonly child?:ChildProcess;readonly closed:Promise<SupervisedClose>;private settle!:(r:SupervisedClose)=>void;private spawnError?:Error;private done=false;private leader?:SupervisedClose;private drainTimer?:NodeJS.Timeout;private groupWatchTimer?:NodeJS.Timeout;
 private terminationRequested=false;private groupDeathConfirmed=false;private termination?:TerminationAttempt;private pendingFinish?:SupervisedClose;
 constructor(private options:SupervisedProcessOptions){const{shell,args}=getShellConfig();this.closed=new Promise(resolve=>{this.settle=resolve;});try{this.child=spawn(shell,[...args,options.command],{cwd:options.cwd,detached:process.platform!=="win32",stdio:["ignore","pipe","pipe"],env:process.env,windowsHide:true});}catch(error){queueMicrotask(()=>this.requestFinish({spawnError:asError(error)}));return;}const child=this.child;child.once("spawn",()=>this.guard(()=>options.onSpawn(child.pid!,process.platform!=="win32"?child.pid:undefined)));child.once("error",error=>{this.spawnError=asError(error);});child.stdout?.on("data",(data:Buffer)=>this.guard(()=>options.onData("stdout",data)));child.stderr?.on("data",(data:Buffer)=>this.guard(()=>options.onData("stderr",data)));
  child.once("exit",(code,signal)=>{this.leader={code:code??undefined,signal:signal??undefined,spawnError:this.spawnError};if(this.groupDeathConfirmed){this.convergeClose();return;}if(this.terminationRequested)return;this.waitForNaturalGroupDeath();});
  child.once("close",(code,signal)=>this.requestFinish(this.leader??{code:code??undefined,signal:signal??undefined,spawnError:this.spawnError}));child.unref();}
 get pid(){return this.done?undefined:this.child?.pid;}
 async terminate(signal:"SIGTERM"|"SIGKILL"="SIGTERM",killAfterMs=5_000):Promise<SupervisedClose>{const pid=this.pid;if(!pid)return this.closed;this.terminationRequested=true;this.clearGroupWatch();if(this.groupDeathConfirmed)return this.closed;if(this.termination){if(signal==="SIGKILL")killProcessTree(pid,"SIGKILL");return this.termination.promise;}this.child?.ref();const promise=(async()=>{try{await terminateProcessTree(pid,signal,killAfterMs);this.confirmGroupDeath();return await this.closed;}finally{this.termination=undefined;this.child?.unref();}})();this.termination={promise};return promise;}
 private waitForNaturalGroupDeath():void{const pid=this.child?.pid;if(!pid){this.confirmGroupDeath();return;}if(!processTreeAlive(pid)){this.confirmGroupDeath();return;}this.groupWatchTimer=setTimeout(()=>{this.groupWatchTimer=undefined;if(!this.terminationRequested)this.waitForNaturalGroupDeath();},20);}
 private confirmGroupDeath():void{if(this.groupDeathConfirmed)return;this.groupDeathConfirmed=true;this.clearGroupWatch();this.convergeClose();}
 private convergeClose():void{if(!this.groupDeathConfirmed||!this.leader)return;if(this.pendingFinish){const result=this.pendingFinish;this.pendingFinish=undefined;this.finish(result);return;}this.armStdioDrain();}
 private armStdioDrain():void{if(this.done||this.drainTimer)return;const child=this.child;this.drainTimer=setTimeout(()=>{if(this.done)return;child?.stdout?.destroy();child?.stderr?.destroy();this.requestFinish({...this.leader,stdioDrainTimedOut:true});},this.options.stdioDrainTimeoutMs??5_000);this.drainTimer.unref?.();}
 private clearGroupWatch():void{if(this.groupWatchTimer)clearTimeout(this.groupWatchTimer);this.groupWatchTimer=undefined;}
 private requestFinish(result:SupervisedClose){if((this.leader||this.terminationRequested)&&!this.groupDeathConfirmed){this.pendingFinish=result;return;}this.finish(result);}
 private guard(fn:()=>void){try{fn();}catch(error){this.options.onCallbackError(asError(error));}}
 private finish(result:SupervisedClose){if(this.done)return;this.done=true;this.clearGroupWatch();if(this.drainTimer)clearTimeout(this.drainTimer);this.settle(result);this.guard(()=>this.options.onClose(result));}
}
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
function asError(error:unknown):Error{return error instanceof Error?error:new Error(String(error));}
