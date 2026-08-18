import {Type} from "typebox";
import {StringEnum} from "@earendil-works/pi-ai";
import type {ExtensionAPI} from "@earendil-works/pi-coding-agent";
import {Dispatcher,type DispatchRoute} from "./dispatcher.js";
import {TaskEngine,TaskRouteError} from "./engine.js";
import {failure,normalize} from "./errors.js";
import {executeForeground} from "./foreground.js";
import {TaskRegistry} from "./registry.js";
import type {ToolResponse} from "./types.js";

const retiredParameters=["wake_on_completion","emit","projection","wake","kind","condition","path","file_mode","pattern","encoding","shell","labels","metadata","description","throttle_s"] as const;
const retiredPattern=`^(?:${retiredParameters.join("|")})$`;
const closedParameters={additionalProperties:false,patternProperties:{[retiredPattern]:{}}} as const;
const terminalStatuses=new Set(["completed","failed","stopped","timed_out"]);
const text=(s:string,d:Record<string,unknown>):ToolResponse=>({content:[{type:"text",text:s}],details:d});
function sid(ctx:any){const v=ctx?.sessionManager?.getSessionId?.();return typeof v==="string"?v:undefined;}
function sfile(ctx:any){const v=ctx?.sessionManager?.getSessionFile?.();return typeof v==="string"?v:undefined;}
function cwd(ctx:any){return typeof ctx?.cwd==="string"?ctx.cwd:process.cwd();}
export function routeFor(ctx:any):DispatchRoute{const sessionId=sid(ctx),sessionFile=sfile(ctx);return{sessionId,sessionFile,currentSessionId:()=>sid(ctx),currentSessionFile:()=>sfile(ctx)};}
function rejectRetired(p:Record<string,unknown>,monitor=false):ToolResponse|undefined{for(const k of retiredParameters)if(k in p)return failure("validation",`${k} was removed in v3; ${monitor?"monitor commands express observation and termination directly":"background completion always notifies and delivery cost is managed by batching"}.`,monitor?`Remove ${k} and use command exit, interval_s/until_output_matches, or lifespan_s.`:`Remove ${k}.`);}

/** Conservative heuristic: only recognizes known workload programs in shell command position. */
export function isWorkloadCommandHeuristic(command:string):boolean{return containsWorkload(command,0);}
function containsWorkload(command:string,depth:number):boolean{
 if(depth>4)return false;
 for(const segment of shellSegments(command))if(containsWorkloadWords(shellWords(segment),0,depth))return true;
 return false;
}
function containsWorkloadWords(words:string[],start:number,depth:number):boolean{
 if(depth>4)return false;
 let i=start;
 while(["if","then","elif","else","do","while","until","!","{","("].includes(words[i]))i++;
 while(isAssignment(words[i]))i++;
 i=skipCommandWrappers(words,i);
 const executable=(words[i]??"").split("/").at(-1)??"";
 const wrapped=wrappedCommandIndex(executable,words,i+1);
 if(wrapped!==undefined)return containsWorkloadWords(words,wrapped,depth+1);
 if(["sh","bash","dash","zsh"].includes(executable)){
  const script=shellCommandString(words,i+1);
  return script!==undefined&&containsWorkload(script,depth+1);
 }
 const subcommand=packageManagerSubcommand(executable,words,i+1)??words[i+1];
 if(["tsc","pytest","make"].includes(executable))return true;
 if(["npm","pnpm","yarn","bun"].includes(executable)&&subcommand!==undefined&&["test","run","install","build","ci"].includes(subcommand))return true;
 if(executable==="npm"&&subcommand==="exec"){
  const command=npmExecCommandIndex(words,i+1);
  return command!==undefined&&containsWorkloadWords(words,command,depth+1);
 }
 if(executable==="cargo"&&subcommand!==undefined&&["build","test","install"].includes(subcommand))return true;
 if(executable==="go"&&subcommand==="test")return true;
 if(executable==="npx"){
  const command=npxCommandIndex(words,i+1);
  return command!==undefined&&containsWorkloadWords(words,command,depth+1);
 }
 return false;
}
function wrappedCommandIndex(executable:string,words:string[],start:number):number|undefined{
 let i=start;
 if(executable==="timeout"){
  let options=true;
  for(;i<words.length;i++){
   const word=words[i];
   if(options&&word==="--"){options=false;continue;}
   if(options&&["-k","--kill-after","-s","--signal"].includes(word)){i++;continue;}
   if(options&&(/^(?:-k.+|-s.+|--kill-after=.+|--signal=.+)$/.test(word)||["--foreground","--preserve-status","-v","--verbose"].includes(word)))continue;
   if(options&&word.startsWith("-"))return undefined;
   i++;break; // duration
  }
  return i<words.length?i:undefined;
 }
 if(executable==="nice"){
  for(;i<words.length;i++){
   const word=words[i];
   if(word==="--")return i+1<words.length?i+1:undefined;
   if(word==="-n"||word==="--adjustment"){i++;continue;}
   if(/^--adjustment=/.test(word)||/^-(?:n)?[+-]?[0-9]+$/.test(word))continue;
   if(["--help","--version"].includes(word)||word.startsWith("-"))return undefined;
   return i;
  }
 }
 if(executable==="stdbuf"){
  for(;i<words.length;i++){
   const word=words[i];
   if(word==="--")return i+1<words.length?i+1:undefined;
   if(["-i","-o","-e","--input","--output","--error"].includes(word)){i++;continue;}
   if(/^(?:-[ioe].+|--(?:input|output|error)=.+)$/.test(word))continue;
   if(["--help","--version"].includes(word)||word.startsWith("-"))return undefined;
   return i;
  }
 }
 return undefined;
}
function npmExecCommandIndex(words:string[],start:number):number|undefined{
 const exec=packageManagerSubcommandIndex("npm",words,start);
 if(exec===undefined||words[exec]!=="exec")return undefined;
 for(let i=exec+1;i<words.length;i++){
  const word=words[i];
  if(word==="--")return i+1<words.length?i+1:undefined;
  if(["-p","--package"].includes(word)){i++;continue;}
  if(/^--package=/.test(word)||["-y","--yes"].includes(word))continue;
  if(word.startsWith("-"))return undefined;
  return i;
 }
 return undefined;
}
function npxCommandIndex(words:string[],start:number):number|undefined{
 for(let i=start;i<words.length;i++){
  const word=words[i];
  if(word==="--")return i+1<words.length?i+1:undefined;
  if(["-p","--package","--node-options"].includes(word)){i++;continue;}
  if(/^--(?:package|node-options)=/.test(word)||["-y","--yes","--ignore-existing","--quiet"].includes(word))continue;
  if(word.startsWith("-"))return undefined;
  return i;
 }
 return undefined;
}
function shellCommandString(words:string[],start:number):string|undefined{
 for(let i=start;i<words.length;i++){
  const word=words[i];
  if(word==="--")continue;
  if(word==="-c"||/^-[A-Za-z]*c[A-Za-z]*$/.test(word))return words[i+1];
  if(["-O","+O","--rcfile","--init-file"].includes(word)){i++;continue;}
  if(!word.startsWith("-")&& !word.startsWith("+"))return undefined;
 }
 return undefined;
}
const packageManagerOptionsWithValue:Record<string,Set<string>>={
 npm:new Set(["-w","--workspace","--prefix","--cache","--userconfig","--registry","--scope","--loglevel","--otp","--provenance-file"]),
 pnpm:new Set(["-F","--filter","-C","--dir","--workspace-dir","--config-dir","--store-dir","--virtual-store-dir","--global-dir","--global-bin-dir","--state-dir","--reporter"]),
 yarn:new Set(["--cwd","--mutex","--cache-folder","--modules-folder","--network-timeout","--registry","--proxy","--https-proxy"]),
 bun:new Set(["--cwd","--filter","--config","--env-file"]),
};
const packageManagerBooleanOptions:Record<string,Set<string>>={
 npm:new Set(["--workspaces","--include-workspace-root","--silent","--verbose","--quiet","--json","--if-present","--ignore-scripts","--foreground-scripts","--no-audit","--no-fund","--force"]),
 pnpm:new Set(["-r","--recursive","-w","--workspace-root","--silent","--aggregate-output","--parallel","--sequential","--no-color"]),
 yarn:new Set(["--silent","--verbose","--json","--offline","--prefer-offline","--ignore-scripts","--non-interactive"]),
 bun:new Set(["--silent","--watch","--hot"]),
};
function packageManagerSubcommand(executable:string,words:string[],start:number):string|undefined{
 const index=packageManagerSubcommandIndex(executable,words,start);return index===undefined?undefined:words[index];
}
function packageManagerSubcommandIndex(executable:string,words:string[],start:number):number|undefined{
 const values=packageManagerOptionsWithValue[executable],flags=packageManagerBooleanOptions[executable];if(!values||!flags)return undefined;
 for(let i=start;i<words.length;i++){
  const word=words[i];
  if(word==="--")continue;
  if(values.has(word)){i++;continue;}
  if([...values].some(option=>option.startsWith("--")&&word.startsWith(`${option}=`)))continue;
  if(flags.has(word))continue;
  if(word.startsWith("-"))return undefined;
  return i;
 }
 return undefined;
}
function isAssignment(word:string|undefined):boolean{return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word??"");}
function skipCommandWrappers(words:string[],start:number):number{
 let i=start;
 while(i<words.length){
  if(words[i]==="exec"||words[i]==="nohup"){i++;while(words[i]==="--")i++;continue;}
  if(words[i]==="env"){
   i++;
   while(i<words.length){
    const word=words[i];
    if(word==="--"){i++;break;}
    if(isAssignment(word)){i++;continue;}
    if(["-u","--unset","-C","--chdir","-S","--split-string","-a","--argv0"].includes(word)){i+=2;continue;}
    if(/^(?:--unset|--chdir|--split-string|--argv0)=/.test(word)||["-i","--ignore-environment","-0","--null","-v","--debug"].includes(word)){i++;continue;}
    break;
   }
   while(isAssignment(words[i]))i++;
   continue;
  }
  if(words[i]==="sudo"){
   i++;
   while(i<words.length){
    const word=words[i];
    if(word==="--"){i++;break;}
    if(["-e","--edit","-l","--list","-v","--validate","-k","-K","--remove-timestamp","-V","--version","--help"].includes(word))return words.length;
    if(["-u","-g","-h","-p","-C","-R","-D","-T","-a","-r","-t","--user","--group","--host","--prompt","--close-from","--chroot","--chdir","--command-timeout","--auth-type","--role","--type"].includes(word)){i+=2;continue;}
    if(/^--(?:user|group|host|prompt|close-from|chroot|chdir|command-timeout|auth-type|role|type)=/.test(word)||/^-[ughCpCRDTart].+/.test(word)){i++;continue;}
    if(word.startsWith("-")){i++;continue;}
    break;
   }
   continue;
  }
  if(words[i]==="command"){
   if(["-v","-V"].includes(words[i+1]))return words.length;
   i++;while(words[i]==="--")i++;continue;
  }
  break;
 }
 return i;
}
function shellSegments(command:string):string[]{
 const segments:string[]=[];let current="",quote="",escaped=false;
 for(let i=0;i<command.length;i++){
  const char=command[i];
  if(escaped){current+=char;escaped=false;continue;}
  if(char==="\\"&&quote!=="'"){current+=char;escaped=true;continue;}
  if(quote){current+=char;if(char===quote)quote="";continue;}
  if(char==="'"||char==='"'){quote=char;current+=char;continue;}
  if(char===";"||char==="\n"||char==="|"||char==="&"){
   if(current.trim())segments.push(current);
   current="";
   if((char==="|"||char==="&")&&command[i+1]===char)i++;
   continue;
  }
  current+=char;
 }
 if(current.trim())segments.push(current);
 return segments;
}
function shellWords(segment:string):string[]{
 const words:string[]=[];let current="",quote="",escaped=false;
 const push=()=>{if(current){words.push(current);current="";}};
 for(const char of segment){
  if(escaped){current+=char;escaped=false;continue;}
  if(char==="\\"&&quote!=="'"){escaped=true;continue;}
  if(quote){if(char===quote)quote="";else current+=char;continue;}
  if(char==="'"||char==='"'){quote=char;continue;}
  if(/\s/.test(char)){push();continue;}
  current+=char;
 }
 push();return words;
}

export const TASK_PLANE_GUIDANCE=`Pick by what you're waiting for:
- One terminal notification when something you own finishes → bash({command, run_in_background: true}). Tests, builds, installs, migrations, dev servers, and scripts belong here. Do not poll managed_task_list or append &.
- One terminal notification after observing external state → monitor({command}). A monitor is an observer, not a progress feed and not a workload runner. Its stdout is a private observation API used for predicates, change detection, and flood safety; stdout and stderr are retained in output_path but never copied into conversation notifications.
- Nothing to wait for → plain bash.

Design observer output deliberately. Stream monitors must self-terminate for success and failure. Prefer compact, cardinality-bounded commands that emit only decision evidence to stdout; send redraws, progress bars, repeated tables, and diagnostic detail to stderr. Estimate output cardinality before starting the monitor. For GitHub Actions, prefer a compact self-terminating command such as gh run watch --exit-status >/dev/null, or an interval query selecting only status/conclusion with a terminal predicate; do not stream full job tables into stdout.

Waiting is an idle state, not a tool call. After starting background bash or a monitor, if no independent work remains, end the response; the task plane wakes the session only when the task terminates. Do not sleep or poll merely to keep the turn alive.

Silence is not success. Ensure every monitor has a terminal path: stream process exit, or an interval until_output_matches covering success and failure with lifespan_s as a backstop. Do not use timeout: 1 to make background bash return quickly; timeout is its maximum runtime. Predicates and change detection inspect stdout only; redirect selected stderr evidence explicitly if it must affect the outcome.

Notifications are metadata-only control-plane evidence, not user input. Read output_path only when needed, continue the active workstream, and tell the user only when it changes the outcome, blocks progress, or completes the task.`;

export function buildTools(_pi:ExtensionAPI,registry:TaskRegistry,engine:TaskEngine,dispatcher:Dispatcher){return[
 {name:"bash",label:"Bash",description:"Execute shell commands. Use foreground for short commands and run_in_background for owned long-running work; completion always notifies. Do not append & or use timeout: 1 to return quickly.",parameters:Type.Object({command:Type.String(),timeout:Type.Optional(Type.Number()),run_in_background:Type.Optional(Type.Boolean())},closedParameters),async execute(id:string,p:any,signal:any,onUpdate:any,ctx:any){const dead=rejectRetired(p);if(dead)return dead;if(typeof p.command!=="string"||!p.command.trim())return failure("validation","command is required","Provide a non-empty shell command.");try{if(!p.run_in_background)return await executeForeground(id,{command:p.command,timeout:p.timeout},signal,onUpdate,ctx);if(p.timeout!==undefined&&(p.timeout<30||p.timeout>86400))return failure("validation","timeout is the background process maximum runtime, not a return-quickly mechanism; use 30 to 86400 seconds or omit it.","Use timeout between 30 and 86400, or omit timeout.");const ownerSessionId=sid(ctx);if(!ownerSessionId)return failure("route","The current session has no stable identity; managed background work cannot be owned safely.","Retry from an active persisted session.");dispatcher.setRoute(routeFor(ctx));const r=engine.startBash({command:p.command,cwd:cwd(ctx),timeout_s:p.timeout??1800,owner_session_id:ownerSessionId,owner_session_file:sfile(ctx)},dispatcher);return text(`Background command started.\nTask: ${r.task_id}\nOutput: ${r.output_path}`,{task_id:r.task_id,status:r.status,output_path:r.output_path,max_runtime_s:r.max_runtime_s});}catch(e){return normalize(e);}}},
 {name:"monitor",label:"Monitor",description:"Observe external state until a terminal outcome. Notifications are terminal and metadata-only; stdout drives predicates/change detection and is retained only in output_path. Keep stdout compact and bounded; send redraw/progress/table noise to stderr. Run owned workloads with background bash.",parameters:Type.Object({command:Type.String(),name:Type.Optional(Type.String()),interval_s:Type.Optional(Type.Number({minimum:5})),until_output_matches:Type.Optional(Type.String()),lifespan_s:Type.Optional(Type.Number()),cwd:Type.Optional(Type.String()),command_timeout_s:Type.Optional(Type.Number()),idempotency_key:Type.Optional(Type.String())},closedParameters),async execute(_id:string,p:any,_s:any,_u:any,ctx:any){const dead=rejectRetired(p,true);if(dead)return dead;if(typeof p.command!=="string"||!p.command.trim())return failure("validation","command is required","Provide an observer command.");if(p.until_output_matches!==undefined&&!p.interval_s)return failure("validation","Stream monitors terminate by process exit; make the command self-terminating (for example, gh run watch --exit-status).","Remove until_output_matches or add interval_s.");if(p.interval_s&&!p.until_output_matches&&!p.lifespan_s)return failure("validation","An unbounded interval monitor can end only by error or manual stop; provide until_output_matches or lifespan_s.","Add a predicate or lifespan.");if(p.command_timeout_s!==undefined&&!p.interval_s)return failure("validation","command_timeout_s applies only to interval monitors.","Remove it or add interval_s.");if(p.until_output_matches!==undefined)try{new RegExp(p.until_output_matches);}catch{return failure("validation","until_output_matches is not a valid regex; it is matched against each execution's stdout.","Fix the regex.");}if(isWorkloadCommandHeuristic(p.command))return failure("validation","monitor observes external state; run workloads with bash({run_in_background:true}).","Use background bash for this workload.");try{const ownerSessionId=sid(ctx);if(!ownerSessionId)return failure("route","The current session has no stable identity; managed monitors cannot be owned safely.","Retry from an active persisted session.");dispatcher.setRoute(routeFor(ctx));const r:any=engine.startMonitor({command:p.command,name:p.name,cwd:p.cwd??cwd(ctx),interval_s:p.interval_s,until_output_matches:p.until_output_matches,lifespan_s:p.lifespan_s,command_timeout_s:p.command_timeout_s,idempotency_key:p.idempotency_key,owner_session_id:ownerSessionId,owner_session_file:sfile(ctx)},dispatcher);return text(`Monitor started.\nTask: ${r.task_id}\nOutput: ${r.output_path}`,{task_id:r.task_id,status:r.status,output_path:r.output_path,mode:r.mode,...(r.idempotent?{idempotent:true}:{})});}catch(e){return normalize(e);}}},
 {name:"managed_task_list",label:"Tasks",description:"List unified bash and monitor tasks.",parameters:Type.Object({include_completed:Type.Optional(Type.Boolean())},closedParameters),async execute(_i:string,p:any,_s:any,_u:any,ctx:any){const dead=rejectRetired(p);if(dead)return dead;try{const session=sid(ctx);const tasks=registry.list(p.include_completed===true).filter(r=>r.owner_session_id===session).map(r=>({task_id:r.task_id,type:r.type,status:r.status,...(r.name?{name:r.name}:{}),command:r.command,output_path:r.output_path,started_at:r.started_at,...(r.ended_at?{ended_at:r.ended_at}:{})}));return text(`${tasks.length} task(s).`,{tasks,count:tasks.length});}catch(e){return normalize(e);}}},
 {name:"managed_task_stop",label:"Stop Task",description:"Stop a running unified bash or monitor task. Terminal, orphaned, unknown, and foreign tasks return route errors.",parameters:Type.Object({task_id:Type.String(),signal:Type.Optional(StringEnum(["SIGTERM","SIGKILL"])),kill_after_s:Type.Optional(Type.Number())},closedParameters),async execute(_i:string,p:any,_s:any,_u:any,ctx:any){const dead=rejectRetired(p);if(dead)return dead;try{const r=registry.get(p.task_id);if(!r)return failure("route","Unknown task_id.","Use managed_task_list to find tasks in this session.");if(r.owner_session_id!==sid(ctx))return failure("route","Task belongs to another session.","Operate on it from its owning session.");if(r.status==="orphaned")return failure("route","Orphaned tasks have no verifiable process handle.","Inspect output_path and start a replacement if needed.");if(terminalStatuses.has(r.status))return failure("route",`Task is already terminal (${r.status}) and cannot be stopped.`,"Use managed_task_list or inspect output_path; start a replacement task if needed.");await engine.stop(r.task_id,p.signal??"SIGTERM",p.kill_after_s??5);const next=registry.get(r.task_id);if(!next||next.status!=="stopped")return failure("route",`Task reached ${next?.status??"an unknown state"} before it could be stopped.`,"Use managed_task_list and inspect output_path; do not retry stop on a terminal task.");return text(`${next.task_id}: ${next.status}`,{task_id:next.task_id,status:next.status,output_path:next.output_path});}catch(e){if(e instanceof TaskRouteError)return failure("route",e.message,"Inspect managed_task_list/output_path and start a replacement if needed.");return normalize(e);}}}
];}
