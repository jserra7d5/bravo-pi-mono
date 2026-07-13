import test from "node:test";
import assert from "node:assert/strict";
import { execBounded } from "../src/process.js";

test("execBounded rejects an already-aborted signal without spawning",async()=>{
  const controller=new AbortController(),reason=new Error("already aborted");controller.abort(reason);
  await assert.rejects(execBounded({executable:"/definitely/not/executable",args:[]},1000,1024,controller.signal),error=>error===reason);
});
