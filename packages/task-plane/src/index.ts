import {closeSync,existsSync,mkdirSync,openSync} from "node:fs";
import {join} from "node:path";
import {registerSessionResourceCleanup} from "@earendil-works/pi-ai";
import type {ExtensionAPI,ExtensionContext} from "@earendil-works/pi-coding-agent";
import {Dispatcher} from "./dispatcher.js";
import {TaskEngine} from "./engine.js";
import {TaskRegistry} from "./registry.js";
import {buildTools,routeFor,TASK_PLANE_GUIDANCE} from "./tools.js";

const TOOL_NAMES=["bash","monitor","task_list","task_stop"] as const;
type ToolLike={name?:unknown;extensionId?:unknown;source?:unknown;sourceInfo?:Record<string,unknown>}|string;
function toolName(tool:ToolLike){return typeof tool==="string"?tool:typeof tool.name==="string"?tool.name:undefined;}
function isOurs(tool:ToolLike){if(typeof tool==="string")return false;return [tool.extensionId,tool.source,...Object.values(tool.sourceInfo??{})].some(value=>typeof value==="string"&&(value.includes("pi-extension-task-plane")||value.includes("/task-plane/")));}
async function verifiedToolOverride(pi:ExtensionAPI){
 const api=pi as any;
 if(typeof api.getActiveTools!=="function"||typeof api.getAllTools!=="function")return false;
 try{
  const active:ToolLike[]=await api.getActiveTools(),all:ToolLike[]=await api.getAllTools();
  return TOOL_NAMES.every(name=>active.filter(tool=>toolName(tool)===name).length===1&&all.filter(tool=>toolName(tool)===name).length===1&&all.filter(tool=>toolName(tool)===name&&isOurs(tool)).length===1);
 }catch{return false;}
}

export default async function taskPlane(pi:ExtensionAPI){
 const registry=new TaskRegistry(),engine=new TaskEngine(registry),dispatcher=new Dispatcher(pi,registry,{currentSessionId:()=>undefined,currentSessionFile:()=>undefined});
 const sessionIds=new Set<string>();
 let unregisterCleanup=()=>{};
 const startShutdown=(sessionId:string)=>{sessionIds.delete(sessionId);unregisterCleanup();engine.beginShutdown();return engine.shutdown(sessionId);};
 unregisterCleanup=registerSessionResourceCleanup(sessionId=>{
  if(!sessionId||!sessionIds.has(sessionId))return;
  void startShutdown(sessionId).catch(error=>console.warn(`task-plane dispose shutdown failed for ${sessionId}: ${error instanceof Error?error.message:String(error)}`));
 });
 noticeRetiredRoots();
 for(const tool of buildTools(pi,registry,engine,dispatcher))pi.registerTool(tool as never);
 pi.on?.("before_agent_start",async(event:any)=>{
  if(!(await verifiedToolOverride(pi))||event.systemPrompt.includes(TASK_PLANE_GUIDANCE))return{systemPrompt:event.systemPrompt};
  return{systemPrompt:`${event.systemPrompt}\n\n${TASK_PLANE_GUIDANCE}`};
 });
 const on=pi.on as any;
 on?.("session_start",async(_event:unknown,ctx:ExtensionContext)=>{const sessionId=(ctx as any).sessionManager?.getSessionId?.();if(typeof sessionId==="string")sessionIds.add(sessionId);dispatcher.setRoute(routeFor(ctx));engine.rehydrate(sessionId,()=>dispatcher);});
 on?.("session_shutdown",async(_event:unknown,ctx:ExtensionContext)=>{const sessionId=(ctx as any).sessionManager?.getSessionId?.();unregisterCleanup();if(typeof sessionId==="string")await startShutdown(sessionId);});
}

function noticeRetiredRoots(){
 const home=process.env.HOME;
 if(!home)return;
 const markerRoot=process.env.PI_TASK_PLANE_HOME||join(home,".pi","task-plane");
 for(const [name,oldRoot] of [["monitor",join(home,".pi","monitor")],["background-bash",join(home,".pi","background-bash")]] as const){
  if(!existsSync(oldRoot))continue;
  const marker=join(markerRoot,`.retired-${name}-noticed`);
  try{
   mkdirSync(markerRoot,{recursive:true,mode:0o700});
   const fd=openSync(marker,"wx",0o600);
   closeSync(fd);
   console.warn(`task-plane retired state root ${oldRoot}; records were left in place and were not migrated or read`);
  }catch(error){
   if((error as NodeJS.ErrnoException)?.code!=="EEXIST")console.warn(`task-plane could not record retired state notice for ${oldRoot} at ${marker}: ${error instanceof Error?error.message:String(error)}`);
  }
 }
}

export {TaskRegistry,nodeRegistryFs,type RegistryFsPort} from "./registry.js";
export {TaskEngine} from "./engine.js";
export {Dispatcher} from "./dispatcher.js";
