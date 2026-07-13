import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { AgentStatusRegistry } from "../src/agent-status-registry.js";
import { parseAgentStatusReport, type AgentStatusReportV1 } from "../src/agent-status-protocol.js";
import { AgentStatusServer, defaultAgentStatusSocketPath } from "../src/agent-status-server.js";
import { WorkspaceUiServer } from "../src/workspace-ui.js";
import { discoverExecutable } from "../src/discovery.js";
import type { BrowserWorkspaceConfigV1 } from "../src/contracts.js";
import { execBounded } from "../src/process.js";
import { chromium } from "playwright";
import { pathToFileURL } from "node:url";

const workspace = "bw-0123456789abcdef01234567";
const workspaceB = "bw-abcdef0123456789abcdef01";
const base = (overrides: Partial<AgentStatusReportV1> = {}): AgentStatusReportV1 => ({ protocolVersion: 1, type: "lead_async_running_count", workspace: { name: workspace, tmuxSocketPath: "/tmp/socket", tmuxSessionId: "$1" }, lead: { piSessionId: "pi-1", rootSessionId: "root_1" }, reporterInstanceId: "a".repeat(32), sequence: 1, runningCount: 2, ttlMs: 7000, ...overrides });

async function freePort(): Promise<number> { return new Promise((resolve, reject) => { const server = net.createServer(); server.listen(0, "127.0.0.1", () => { const address = server.address(); server.close(error => error ? reject(error) : resolve(typeof address === "object" && address ? address.port : 0)); }); }); }
async function rawSocketText(socketPath: string, write: (socket: net.Socket) => void): Promise<string> { return new Promise((resolve, reject) => { const socket=net.createConnection({path:socketPath,allowHalfOpen:true},()=>write(socket));let body="";socket.on("data",c=>body+=c);socket.on("end",()=>resolve(body));socket.on("error",reject); }); }
async function rawSocketRequest(socketPath: string, write: (socket: net.Socket) => void): Promise<any> { const body=await rawSocketText(socketPath,write);return JSON.parse(body); }
async function socketRequest(socketPath: string, value: unknown): Promise<any> { return rawSocketRequest(socketPath,socket=>socket.end(`${JSON.stringify(value)}\n`)); }
async function waitForFile(file:string):Promise<void>{for(let i=0;i<50;i++){if(fs.existsSync(file))return;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error(`timed out waiting for ${file}`);}

test("v1 parser requires exact bounded fields", () => {
  assert.deepEqual(parseAgentStatusReport(JSON.stringify(base())).report, base());
  assert.equal(parseAgentStatusReport(JSON.stringify({ ...base(), extra: true })).code, "invalid_request");
  assert.equal(parseAgentStatusReport(JSON.stringify({ ...base(), protocolVersion: 2 })).code, "unsupported_version");
  assert.equal(parseAgentStatusReport(JSON.stringify(base({ ttlMs: 2999 }))).code, "invalid_request");
  assert.equal(parseAgentStatusReport(JSON.stringify(base({ runningCount: Number.MAX_SAFE_INTEGER }))).code, "invalid_request");
});

test("registry expires monotonically and rejects rollback/conflict", () => {
  let now=100; const registry=new AgentStatusRegistry(()=>now);
  assert.equal(registry.accept(base()).ok,true);
  assert.deepEqual(registry.accept(base({ sequence: 1 })),{ok:false,code:"stale_sequence"});
  assert.deepEqual(registry.accept(base({ sequence: 2, lead:{piSessionId:"other",rootSessionId:"root_1"} })),{ok:false,code:"lead_conflict"});
  assert.equal(registry.accept(base({ sequence: 1, reporterInstanceId:"b".repeat(32) })).ok,true);
  assert.deepEqual(registry.accept(base({ sequence: 3 })),{ok:false,code:"stale_sequence"});
  now=7100; assert.equal(registry.get(workspace),undefined);
});

test("real Unix socket binds exact real tmux identity and projects through HTTP", { timeout: 20_000 }, async t => {
  const tmux=discoverExecutable("tmux"), ttyd=discoverExecutable("ttyd"), tailscale=discoverExecutable("tailscale"); if(!tmux||!ttyd||!tailscale)return t.skip("tmux dependencies unavailable");
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"bw-status-")), runtime=path.join(dir,"runtime"),tmuxTmp=path.join(dir,"tmux-tmp");fs.mkdirSync(runtime,{mode:0o700});fs.mkdirSync(tmuxTmp,{mode:0o700});
  const config:BrowserWorkspaceConfigV1={schemaVersion:1,workspace:dir,listenHost:"127.0.0.1",listenPort:await freePort(),tmuxSocketName:`bw-test-${process.pid}-${Date.now()}`,tmuxSessionName:"workspace",tailscaleHttpsPort:8443,executables:{tmux,ttyd,tailscale}};
  const tmuxEnv={...process.env,TMUX_TMPDIR:tmuxTmp};const run=(...args:string[])=>execBounded({executable:tmux,args:["-L",config.tmuxSocketName,...args],env:tmuxEnv},3000);let failUiInspection=false;const uiTmux:typeof execBounded=(command,timeout,maxBytes,signal)=>failUiInspection?Promise.resolve({stdout:"",stderr:"injected failure",code:1,signal:null}):execBounded(command,timeout,maxBytes,signal);const registry=new AgentStatusRegistry();const serviceEnv={...tmuxEnv,XDG_RUNTIME_DIR:runtime}; const status=new AgentStatusServer(config,registry,serviceEnv,defaultAgentStatusSocketPath(serviceEnv),uiTmux); const ui=new WorkspaceUiServer(config,1,dir,registry,tmuxEnv,uiTmux);let browser;
  try{
    assert.equal((await run("new-session","-d","-s",workspace,"-c",dir)).code,0);assert.equal((await run("new-session","-d","-s",workspaceB,"-c",dir)).code,0); const listed=await run("list-sessions","-F","#{session_name}\t#{session_id}\t#{socket_path}"); const row=listed.stdout.trim().split("\n").find(x=>x.startsWith(`${workspace}\t`));assert.ok(row);const [,sessionId,socketPath]=row!.split("\t");
    await status.start();assert.equal(fs.statSync(status.socketPath).mode&0o777,0o600);assert.ok(socketPath.startsWith(tmuxTmp),`expected TMUX_TMPDIR socket, got ${socketPath}`);await ui.start();
    const report=base({workspace:{name:workspace,tmuxSocketPath:socketPath,tmuxSessionId:sessionId},runningCount:2});
    const delayedDouble=await rawSocketRequest(status.socketPath,socket=>{socket.write(`${JSON.stringify(report)}\n`);setTimeout(()=>socket.end(`${JSON.stringify({...report,sequence:2})}\n`),25)});assert.equal(delayedDouble.code,"invalid_request");
    const noNewline=await rawSocketRequest(status.socketPath,socket=>socket.end(JSON.stringify(report)));assert.equal(noNewline.code,"invalid_request");
    const oversized=await rawSocketRequest(status.socketPath,socket=>socket.end(`${JSON.stringify(report)}${" ".repeat(8192)}\n`));assert.equal(oversized.code,"invalid_request");
    const accepted=await socketRequest(status.socketPath,report);assert.equal(accepted.ok,true);registry.evict(workspace);
    const asyncRoot=path.resolve(import.meta.dirname,"../../../async-subagents/dist"),producer=path.join(dir,"produce.mjs"),runIds=path.join(dir,"run-ids.json");
    assert.ok(fs.existsSync(path.join(asyncRoot,"src/runStore.js")), "build @bravo/async-subagents before the cross-package status lane");
    fs.writeFileSync(producer,`import fs from 'node:fs';\nimport {RunStore} from '${pathToFileURL(path.join(asyncRoot,"src/runStore.js"))}';\nimport {createInitialStatus} from '${pathToFileURL(path.join(asyncRoot,"src/status.js"))}';\nimport {readRunningSubagentCount} from '${pathToFileURL(path.join(asyncRoot,"extensions/pi/liveWidget.js"))}';\nimport {BrowserWorkspaceStatusReporter,defaultBrowserWorkspaceStatusSocketPath,resolveBrowserWorkspaceIdentity} from '${pathToFileURL(path.join(asyncRoot,"extensions/pi/browserWorkspaceStatus.js"))}';\nconst store=new RunStore({cwd:${JSON.stringify(dir)}}),idsFile=${JSON.stringify(runIds)};let ids=[];if(process.env.REPORT_PHASE==='positive'){for(const state of ['running','running','blocked','completed']){const {runId}=store.createRunDirectory({cwd:${JSON.stringify(dir)},parentRunId:'root_e2e',rootSessionId:'root_e2e'});const initial=createInitialStatus({runId,parentRunId:'root_e2e',rootSessionId:'root_e2e',displayName:state,agentName:'scout',agentSource:'builtin',definitionPath:'/builtin/scout.md',mode:'oneshot',cwd:${JSON.stringify(dir)},state});store.writeStatus({...initial,state,resultReady:state==='completed'});ids.push(runId)}fs.writeFileSync(idsFile,JSON.stringify(ids));}else{ids=JSON.parse(fs.readFileSync(idsFile,'utf8'));for(const id of ids){const current=store.readStatus(id);if(current.state==='running')store.writeStatus({...current,state:'blocked'});}}const records=store.listActiveOrRecentRuns({parentRunId:'root_e2e',rootSessionId:'root_e2e'});const count=readRunningSubagentCount({store,parentRunId:'root_e2e',rootSessionId:'root_e2e',records,pidProber:()=> 'alive'});const workspace=await resolveBrowserWorkspaceIdentity();const socketPath=defaultBrowserWorkspaceStatusSocketPath();if(!workspace||!socketPath)throw new Error('identity unavailable');const reporter=new BrowserWorkspaceStatusReporter({workspace,lead:{piSessionId:'pi-e2e',rootSessionId:'root_e2e'}},socketPath);if(!await reporter.report(count))throw new Error('report rejected');fs.writeFileSync(process.env.DONE_FILE,String(count));`);
    const produce=async(phase:string)=>{const done=path.join(dir,`done-${phase}`);const command=`env XDG_RUNTIME_DIR=${runtime} BRAVO_TMUX_EXECUTABLE=${tmux} REPORT_PHASE=${phase} DONE_FILE=${done} node ${producer}`;assert.equal((await run("new-window","-d","-t",`=${workspace}`,command)).code,0);await waitForFile(done);return fs.readFileSync(done,"utf8")};
    assert.equal(await produce("positive"),"2");
    const projected=await fetch(`http://127.0.0.1:${config.listenPort}/api/session/${workspace}`);assert.equal(projected.headers.get("cache-control"),"no-store");assert.deepEqual(await projected.json(),{live:true,async:{runningCount:2}});assert.deepEqual(await(await fetch(`http://127.0.0.1:${config.listenPort}/api/session/${workspaceB}`)).json(),{live:true});
    const wrong=await socketRequest(status.socketPath,base({sequence:3,workspace:{name:workspace,tmuxSocketPath:socketPath,tmuxSessionId:"$999"}}));assert.deepEqual(wrong,{ok:false,protocolVersion:1,code:"workspace_identity_mismatch"});
    const beforeUnavailable=registry.get(workspace);failUiInspection=true;const unavailableReport=await rawSocketText(status.socketPath,socket=>socket.end(`${JSON.stringify({...report,sequence:3})}\n`));assert.equal(unavailableReport,"");assert.deepEqual(registry.get(workspace),beforeUnavailable);failUiInspection=false;
    if(fs.existsSync(chromium.executablePath())){browser=await chromium.launch({headless:true});const page=await browser.newPage();await page.addInitScript(([key,value])=>localStorage.setItem(key,value),["bravo-browser-workspaces-v1",JSON.stringify({tabs:[{id:workspace,name:"Exact A"},{id:workspaceB,name:"Exact B"}],active:workspace})]);await page.goto(`http://127.0.0.1:${config.listenPort}/`,{waitUntil:"domcontentloaded",timeout:5000});const badge=page.locator(`[data-id="${workspace}"] .async-count`);await badge.waitFor({state:"attached",timeout:5000});assert.equal(await badge.textContent(),"2");assert.equal(await badge.getAttribute("aria-label"),"2 running async subagents");assert.equal(await page.locator(`[data-id="${workspaceB}"] .async-count`).count(),0);const frame=page.locator(`iframe[src*="${workspace}"]`);await frame.evaluate((node:any)=>{node.dataset.proof='same';node.focus()});failUiInspection=true;const unavailable=await fetch(`http://127.0.0.1:${config.listenPort}/api/session/${workspace}`);assert.equal(unavailable.status,503);assert.deepEqual(await unavailable.json(),{error:"tmux unavailable"});const createUnavailable=await fetch(`http://127.0.0.1:${config.listenPort}/api/session`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:"bw-111111111111111111111111"})});assert.equal(createUnavailable.status,503);const terminalUnavailable=await fetch(`http://127.0.0.1:${config.listenPort}/terminal/${workspace}/?arg=${workspace}`);assert.equal(terminalUnavailable.status,503);await page.waitForFunction(id=>!document.querySelector(`[data-id="${id}"] .async-count`),workspace,{timeout:5000});assert.equal(await frame.getAttribute("data-proof"),"same");assert.equal(await frame.evaluate(node=>document.activeElement===node),true);assert.doesNotMatch(await page.locator(`[data-id="${workspace}"] button`).first().innerText(),/stale/u);failUiInspection=false;await page.route(`**/api/session/${workspace}`,route=>route.fulfill({status:200,contentType:"application/json",body:'{"live":"yes","async":{"runningCount":9}}'}));await page.waitForTimeout(2200);assert.equal(await frame.getAttribute("data-proof"),"same");assert.equal(await frame.evaluate(node=>document.activeElement===node),true);assert.equal(await page.locator(`[data-id="${workspace}"] .async-count`).count(),0);await page.unroute(`**/api/session/${workspace}`);assert.equal(await produce("zero"),"0");await run("kill-session","-t",`=${workspace}`);await page.waitForFunction(id=>!document.querySelector(`iframe[src*="${id}"]`),workspace,{timeout:5000});assert.match(await page.locator(`[data-id="${workspace}"]`).textContent()??"",/stale/u);}
    else { await run("kill-session","-t",`=${workspace}`); }
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${config.listenPort}/api/session/${workspace}`)).json(),{live:false});const absentReport=await socketRequest(status.socketPath,{...report,sequence:4});assert.deepEqual(absentReport,{ok:false,protocolVersion:1,code:"workspace_not_live"});
  }finally{await browser?.close();await ui.stop().catch(()=>{});await status.stop().catch(()=>{});await run("kill-server").catch(()=>{});fs.rmSync(dir,{recursive:true,force:true});}
});
