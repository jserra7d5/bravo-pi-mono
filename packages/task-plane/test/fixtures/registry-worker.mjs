import { TaskRegistry } from "../../dist/src/registry.js";
const [root,session,key=""] = process.argv.slice(2);
const registry=new TaskRegistry(root,{lockTimeoutMs:5000,lockRetryMs:2});
try {
 const result=registry.admit(session,{type:key?"monitor":"bash",...(key?{mode:"stream",idempotency_key:key}:{}),command:"true",cwd:process.cwd(),owner_session_id:session,max_output_bytes:1024});
 process.stdout.write(JSON.stringify({ok:true,id:result.record.task_id,idempotent:result.idempotent}));
} catch (error) {
 process.stdout.write(JSON.stringify({ok:false,name:error?.constructor?.name,message:error instanceof Error?error.message:String(error)}));
 process.exitCode=2;
}
