import {RegistryConflictError,RegistryCorruptionError,RegistryError,RegistryRuntimeError} from "./registry.js";
import type { ToolResponse } from "./types.js";
export type ErrorType="validation"|"route"|"runtime";
export function failure(error_type:ErrorType,message:string,suggested_action:string):ToolResponse{return{content:[{type:"text",text:message}],details:{error_type,message,suggested_action},isError:true};}
export function normalize(e:unknown):ToolResponse{const message=e instanceof Error?e.message:String(e);if(e instanceof RegistryConflictError)return failure("route",message,"Refresh task_list and retry only from the owning session.");if(e instanceof RegistryCorruptionError)return failure("runtime",message,"Inspect or repair the task-plane store before retrying; preserve corrupt metadata for diagnosis.");if(e instanceof RegistryRuntimeError)return failure("runtime",message,"Retry once; if it persists, inspect task-plane filesystem permissions and fall back to foreground execution.");if(e instanceof RegistryError)return failure("validation",message,"Correct the task identifier or invocation and retry.");return failure("runtime",message,"Retry once; if it persists, inspect task-plane filesystem permissions and fall back to foreground execution.");}
/* Exhaustive boundary map:
spawn/output append/terminal metadata/registry lock -> runtime, retry/fallback, task fails where persistable, terminal notification only after durable metadata.
invalid regex/dead config -> validation, correct invocation, no task, no notification.
unknown/foreign/orphaned task -> route, list/use owner session, unchanged, no notification.
stop escalation timeout -> runtime, retry SIGKILL, task remains live/orphaned, no fabricated notification.
claim collision -> route/internal duplicate suppression, unchanged, no notification.
dispatch-request persistence -> runtime/internal, terminal remains durable, no host invocation.
post-dispatch persistence -> runtime/internal ambiguity, dispatch_requested remains, never replay, no duplicate invocation.
*/
