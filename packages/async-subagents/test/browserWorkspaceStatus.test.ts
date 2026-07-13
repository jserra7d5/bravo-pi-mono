import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserWorkspaceStatusReporter, defaultBrowserWorkspaceStatusSocketPath, sendBrowserWorkspaceStatusReport } from "../extensions/pi/browserWorkspaceStatus.js";

const identity={workspace:{name:"bw-0123456789abcdef01234567",tmuxSocketPath:"/tmp/tmux/x",tmuxSessionId:"$1"},lead:{piSessionId:"pi",rootSessionId:"root_x"}};

test("reporter emits increasing exact count reports", async () => {
  const seen:any[]=[];const reporter=new BrowserWorkspaceStatusReporter(identity,"/socket",async(_path,report)=>{seen.push(report);return true});
  await reporter.report(2);await reporter.report(0);
  assert.deepEqual(seen.map(x=>[x.sequence,x.runningCount]),[[1,2],[2,0]]);assert.equal(seen[0].reporterInstanceId,seen[1].reporterInstanceId);assert.equal(seen[0].ttlMs,7000);
});

test("socket sender observes bounded accepted response", async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"async-bw-status-")),socketPath=path.join(dir,"s.sock");
  const server=net.createServer(socket=>{socket.once("data",()=>socket.end('{"ok":true,"protocolVersion":1,"acceptedSequence":1,"expiresInMs":7000}\n'));});
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(socketPath,resolve)});
  try{const reporter=new BrowserWorkspaceStatusReporter(identity,socketPath);assert.equal(await reporter.report(1),true);assert.equal(await sendBrowserWorkspaceStatusReport(path.join(dir,"missing"),{} as any,50),false);}finally{await new Promise<void>(resolve=>server.close(()=>resolve()));fs.rmSync(dir,{recursive:true,force:true});}
});

test("default socket path requires absolute XDG runtime",()=>{assert.equal(defaultBrowserWorkspaceStatusSocketPath({XDG_RUNTIME_DIR:"/run/user/1"}),"/run/user/1/bravo-browser-workspace/status-v1.sock");assert.equal(defaultBrowserWorkspaceStatusSocketPath({}),undefined);assert.equal(defaultBrowserWorkspaceStatusSocketPath({XDG_RUNTIME_DIR:"relative"}),undefined);});
