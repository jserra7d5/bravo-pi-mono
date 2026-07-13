import test from "node:test";
import assert from "node:assert/strict";
import { inspectTmuxSession, parseTmuxSessionListing, type TmuxCommandRunner } from "../src/tmux-session-inspection.js";
import type { ExecResult } from "../src/process.js";

const target="bw-0123456789abcdef01234567", other="bw-abcdef0123456789abcdef01", socket="/runtime/tmux/socket";
const result=(stdout:string,overrides:Partial<ExecResult>={}):ExecResult=>({stdout,stderr:"",code:0,signal:null,...overrides});

test("strict tmux listing parser distinguishes only valid live and absent",()=>{
  assert.deepEqual(parseTmuxSessionListing(result(`${target}\t$1\t${socket}\n`),target),{state:"live",sessionId:"$1",socketPath:socket});
  assert.deepEqual(parseTmuxSessionListing(result(`${other}\t$2\t${socket}\n`),target),{state:"absent"});
  const unavailable:ExecResult[]=[
    result("",{code:1}),result("",{code:null,signal:"SIGKILL"}),result(`${target}\t$1\t${socket}\n`,{stderr:"warning"}),
    result(`${target}\tbad\t${socket}\n`),result(`${target}\t$1\trelative\n`),result(`${target}\t$1\n`),
    result(`${target}\t$1\t${socket}\n${target}\t$2\t${socket}\n`),
    result(`${target}\t$1\t${socket}\n${other}\t$1\t${socket}\n`),
    result(`${target}\t$1\t${socket}\n${other}\t$2\t/other/socket\n`),
  ];
  for(const value of unavailable)assert.deepEqual(parseTmuxSessionListing(value,target),{state:"unavailable"});
});

test("tmux inspection maps resolved and rejected operational failures to unavailable",async()=>{
  const failures:Array<()=>Promise<ExecResult>>=[
    async()=>result("",{code:1}),async()=>result("",{code:null,signal:"SIGTERM"}),
    async()=>{throw new Error("timeout")},async()=>{throw new Error("spawn")},async()=>{throw new Error("output")},async()=>{throw new Error("abort")},async()=>{throw "unexpected"},
  ];
  for(const failure of failures){const run:TmuxCommandRunner=()=>failure();assert.deepEqual(await inspectTmuxSession({executable:"/tmux",socketName:"private",targetName:target,run}),{state:"unavailable"});}
});
