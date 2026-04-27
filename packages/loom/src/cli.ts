#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, copyFileSync, rmSync, unlinkSync } from 'node:fs';
import { dirname, resolve, join, relative, basename } from 'node:path';
import { homedir, tmpdir, hostname } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION = '0.1.0';
type Obj = Record<string, any>;
type Ctx = { root: string; container: string; loom: string; config: Obj };

class LoomError extends Error {
  code: string;
  details?: unknown;
  exitCode: number;
  fix?: string;
  transient?: boolean;
  constructor(code: string, message: string, details?: unknown, exitCode = 1, opts: { fix?: string; transient?: boolean } = {}){
    super(message);
    this.code = code;
    this.details = details;
    this.exitCode = exitCode;
    this.fix = opts.fix;
    this.transient = opts.transient;
  }
}
const now = () => new Date().toISOString();
const q = (s: string) => `'${String(s).replaceAll("'", "''")}'`;
const json = (v: unknown) => JSON.stringify(v);
const home = () => process.env.LOOM_HOME || join(process.env.HOME || homedir(), '.loom');

function main() { try { run(process.argv.slice(2)); } catch (e) { fail(e); } }
function fail(e: unknown): never {
  const err = e instanceof LoomError ? e : new LoomError('GENERAL_ERROR', e instanceof Error ? e.message : String(e));
  if (globalJson) console.log(json({ok:false,status:'error',error:{code:err.code,message:err.message,fix:err.fix,transient:err.transient??false,details:err.details}}));
  else {
    console.error(`loom: ${err.code}: ${err.message}`);
    if (err.fix) console.error(`fix: ${err.fix}`);
  }
  process.exit(err.exitCode);
}
let globalJson = false;

function run(argv0: string[]) {
  const {globals, argv} = parseGlobals(argv0); globalJson = globals.json;
  if (globals.version) return out(VERSION);
  if (argv.length === 0) return help();
  const [cmd, ...rest] = argv;
  if (globals.help) return commandHelp(cmd, rest);
  switch(cmd){
    case 'init': return cmdInit(rest, globals);
    case 'list': return cmdList(rest, globals);
    case 'switch': return cmdSwitch(rest, globals);
    case 'create': return cmdCreateTopLevel(rest, globals);
    case 'create-loom': return cmdCreateLoom(rest, globals);
    case 'node': return withCtx(globals, rest, c=>cmdNode(c, rest));
    case 'edge': return withCtx(globals, rest, c=>cmdEdge(c, rest));
    case 'note': return withCtx(globals, rest, c=>cmdNote(c, rest));
    case 'index': return withCtx(globals, rest, c=>cmdIndex(c, rest));
    case 'search': return withCtx(globals, rest, c=>cmdSearch(c, rest));
    case 'context': return withCtx(globals, rest, c=>cmdContext(c, rest));
    case 'artifact': return withCtx(globals, rest, c=>cmdArtifact(c, rest));
    case 'reference': return withCtx(globals, rest, c=>cmdReference(c, rest));
    case 'registry': return cmdRegistry(rest);
    case 'agent': return maybeCtx(globals, rest, c=>cmdAgent(c, rest), ()=>cmdAgentNoCtx(rest));
    case 'graph': return withCtx(globals, rest, c=>cmdGraph(c, rest));
    case 'lock': return withCtx(globals, rest, c=>cmdLock(c, rest));
    case 'inbox': return withCtx(globals, rest, c=>cmdInbox(c, rest));
    case 'notify': return withCtx(globals, rest, c=>cmdNotify(c, rest));
    case 'spawn': return withCtx(globals, rest, c=>cmdSpawn(c, rest));
    case 'dispatch': return withCtx(globals, rest, c=>cmdDispatch(c, rest));
    case 'patch': return withCtx(globals, rest, c=>cmdPatch(c, rest));
    case 'draft': return withCtx(globals, rest, c=>cmdDraft(c, rest));
    case 'schema': return cmdSchema(rest);
    case 'current': return withCtx(globals, rest, c=>outData({loom:c.config.id, alias:c.config.name, root:c.root, loomPath:c.loom}));
    case 'doctor': return withCtx(globals, rest, c=>outData({ok:true, loom:c.config.id, checks:['basic']}));
    default: throw new LoomError('INVALID_ARGUMENT', `unknown command ${cmd}`, undefined, 2);
  }
}

function parseGlobals(argv: string[]) { const globals: Obj = {json:false}; const outv:string[]=[]; for(let i=0;i<argv.length;i++){ const a=argv[i]; if(a==='--json') globals.json=true; else if(a==='--help'||a==='-h') globals.help=true; else if(a==='--version') globals.version=true; else if(a==='-L'||a==='--loom') globals.loom=argv[++i]; else if(a==='--cwd') globals.cwd=argv[++i]; else outv.push(a);} return {globals, argv: outv}; }
function flag(args:string[], name:string, def?:string){ const i=args.indexOf(name); return i>=0 ? args[i+1] : def; }
function has(args:string[], name:string){ return args.includes(name); }
function stripFlags(args:string[], names:string[]){ const r:string[]=[]; for(let i=0;i<args.length;i++){ if(names.includes(args[i])) i++; else if(args[i].startsWith('--') && names.includes(args[i])) i++; else r.push(args[i]); } return r; }
function rejectUnknownFlags(args:string[], allowed:string[]){ for(const a of args){ if(a.startsWith('--') && !allowed.includes(a)) throw new LoomError('INVALID_ARGUMENT',`unknown flag ${a}`,{allowedFlags:allowed},2,{fix:`Use --help for this command.`,transient:false}); } }
function out(s:string){ console.log(s); }
function outData(data:unknown){ console.log(globalJson ? json({ok:true,status:'ok',data,warnings:[],next_steps:[]}) : human(data)); }
function human(v:any): string { if(typeof v==='string') return v; if(Array.isArray(v)) return v.map(human).join('\n'); return JSON.stringify(v,null,2); }

function help(){ out(`loom ${VERSION}\n\nUsage: loom [-L loom] <command> [args]\n\nCommands: init, create, list, switch, create-loom, node, edge, note, index rebuild, search, context, graph, patch, draft, lock, schema, artifact, reference, registry, agent, inbox, notify, spawn, dispatch\n\nAgents: run 'loom agent guide' for a compact Loom operating guide.\nHelp: run 'loom <command> --help' for command-specific usage.`); }
function commandHelp(cmd:string, rest:string[]){
  const topic = [cmd, ...rest].join(' ').trim();
  const docs:Record<string,string>={
    create:`Usage: loom create <name> [--title <title>] [--workspace id=path]\n\nCreate a fresh Loom workstream. If the current directory has no .loom container, this initializes one. If a .loom container already exists, this creates a new Loom inside it. For graph nodes, use: loom node create --title \"Node title\".`,
    'create-loom':`Usage: loom create-loom --name <name> --title <title> [--workspace id=path]\n\nCreate a new Loom inside an existing .loom container. Use this for a fresh workstream when the repo already has Loom initialized. If no .loom container exists yet, use: loom init --name <name> --title <title>.`,
    node:`Usage: loom [-L loom] node <create|show|update|list> ...\n\ncreate [--title text|title words] [--kind kind] [--parent N-0001] [--summary text] [--tag tag]\nshow <node>\nupdate <node> [--title text] [--kind kind] [--state state] [--parent N-0001|none] [--summary text] [--tag tag]\nlist [--kind kind] [--state state] [--parent N-0001|none]`,
    edge:`Usage: loom [-L loom] edge <add|list|types> ...\n\nadd <from-node> --to <to-node> [--type relationship]\nlist [node]\ntypes`,
    context:`Usage: loom [-L loom] context <node> [--brief]\n\nShow node context. --brief omits the full body and returns body_preview/body_omitted for agent control loops.`,
    graph:`Usage: loom [-L loom] graph <summary|doctor> [node] [--scope node]\n\ngraph summary returns compact counts and child/edge summaries. graph doctor detects duplicate edges, broken edges, missing parents, cycles, and suspicious references.`,
    patch:`Usage: loom [-L loom] patch <validate|preview|apply> --stdin [--scope N-0001] [--dry-run] --json\n\nRead a JSON graph patch from stdin. Operations: create_node, add_note, add_edge, add_reference. Use local_ref/ref on create_node and refer to it from later operations as $name.`,
    draft:`Usage: loom [-L loom] draft <create|list|show|commit|discard> ...\n\nStage graph patches for later review/commit. create --stdin [--scope N-0001] [--title text]; commit <draft-id>; discard <draft-id>.`,
    schema:`Usage: loom schema <commands|command> [name] --json\n\nPrint machine-readable command metadata for agents.`, 
    lock:`Usage: loom [-L loom] lock <status|clear-stale>\n\nInspect or remove a stale Loom lock. clear-stale only removes locks whose same-host process is no longer alive.`, 
    reference:`Usage: loom [-L loom] reference <add|list> <node> [path] [--workspace id] [--label text] [--kind kind]\n\nAdd/list file references. Duplicate references are treated as successful no-ops.`,
    note:`Usage: loom [-L loom] note <node> [message | --stdin]\n       loom [-L loom] note add <node> [message | --stdin]\n       loom [-L loom] note list <node>\n       loom [-L loom] note retract <node:note:n> --reason text\n\nAppend/list/retract durable notes. Use --stdin for nontrivial note bodies.`,
  };
  out(docs[topic] || docs[cmd] || `No command-specific help for ${topic}. Run 'loom --help'.`);
}

function cmdInit(args:string[], globals:Obj){ const cwd=resolve(globals.cwd||process.cwd()); const container=join(cwd,'.loom'); if(existsSync(container)) throw new LoomError('REGISTRY_CONFLICT','Loom container already exists here'); mkdirSync(join(container,'looms'),{recursive:true}); writeAtomic(join(container,'config.json'), JSON.stringify({schemaVersion:1,kind:'loom-container',root:'.'},null,2)+'\n'); const result=createLoomInContainer(container,cwd,args); writeAtomic(join(container,'current'), result.config.name+'\n'); outData({loom:result.config, path:result.loom, container}); }
function cmdCreateTopLevel(args:string[], globals:Obj){ const positional=args.find(a=>!a.startsWith('-') && a!==flag(args,'--title') && a!==flag(args,'--workspace') && a!==flag(args,'--name')); const name=flag(args,'--name')||positional; if(!name) throw new LoomError('INVALID_ARGUMENT','loom name required',undefined,2,{fix:'Use: loom create <name> --title "Title"',transient:false}); const title=flag(args,'--title')||name.split(/[-_]+/).filter(Boolean).map(s=>s[0]?.toUpperCase()+s.slice(1)).join(' ')||name; const nextArgs=[...args.filter(a=>a!==positional),'--name',name,'--title',title]; const root=resolve(globals.cwd||process.cwd()); const container=findContainer(root); if(container){ const result=createLoomInContainer(container,dirname(container),nextArgs); writeAtomic(join(container,'current'), result.config.name+'\n'); return outData({loom:result.config,path:result.loom,container,current:result.config.name}); } return cmdInit(nextArgs,globals); }
function cmdCreateLoom(args:string[], globals:Obj){ const root=resolve(globals.cwd||process.cwd()); const container=findContainer(root); if(!container) throw new LoomError('LOOM_NOT_FOUND','could not find Loom container; run loom init first'); const result=createLoomInContainer(container,dirname(container),args); outData({loom:result.config,path:result.loom,container}); }
function cmdList(args:string[], globals:Obj){ const container=findContainer(globals.cwd||process.cwd()); if(!container) throw new LoomError('LOOM_NOT_FOUND','could not find Loom container'); const current=readCurrent(container); const looms=listLocalLooms(container); outData({container,current,looms}); }
function cmdSwitch(args:string[], globals:Obj){ const name=args[0]; if(!name) throw new LoomError('INVALID_ARGUMENT','loom name required',undefined,2); const container=findContainer(globals.cwd||process.cwd()); if(!container) throw new LoomError('LOOM_NOT_FOUND','could not find Loom container'); const loom=localLoomPath(container,name); if(!loom) throw new LoomError('LOOM_NOT_FOUND',`unknown local Loom ${name}`); writeAtomic(join(container,'current'), basename(loom)+'\n'); outData({current:basename(loom), loomPath:loom}); }
function createLoomInContainer(container:string, root:string, args:string[]){ const title=flag(args,'--title')||flag(args,'-t')||'Untitled Loom'; const name=flag(args,'--name')||slug(title); const loom=join(container,'looms',name); if(existsSync(loom)) throw new LoomError('REGISTRY_CONFLICT',`Loom already exists: ${name}`); mkdirSync(join(loom,'nodes'),{recursive:true}); mkdirSync(join(loom,'artifacts'),{recursive:true}); mkdirSync(join(loom,'runtime','context'),{recursive:true}); const id='lm_'+Math.random().toString(36).slice(2,10); const cfg:any={schemaVersion:1,id,name,title,root:'../..',workspaces:[]}; const ws=flag(args,'--workspace'); if(ws){ const [wid,path]=ws.includes('=')?ws.split('='):['repo',ws]; cfg.workspaces.push({id:wid,path,kind:'git'}); } writeAtomic(join(loom,'loom.json'), JSON.stringify(cfg,null,2)+'\n'); writeAtomic(join(loom,'events.jsonl'),''); ensureRegistry(); regExec(`insert or replace into registry_looms(id,alias,title,root_path,loom_path,last_seen_at) values(${q(id)},${q(name)},${q(title)},${q(root)},${q(loom)},${q(now())});`); ensureRuntime(loom); ensureIndex(loom); return {config:cfg, loom}; }

function withCtx(globals:Obj, args:string[], fn:(c:Ctx)=>void){ fn(resolveCtx(globals,args)); }
function maybeCtx(globals:Obj,args:string[], fn:(c:Ctx)=>void, no:()=>void){ try{fn(resolveCtx(globals,args));}catch(e){ if(e instanceof LoomError && e.code==='LOOM_NOT_FOUND') no(); else throw e; } }
function resolveCtx(globals:Obj,args:string[]):Ctx{ let ref=globals.loom; for(const a of args){ const m=a.match(/^([^:]+):(N-\d+)$/); if(m){ ref=m[1]; break; }} if(!ref && process.env.LOOM_CONTEXT && existsSync(process.env.LOOM_CONTEXT)){ const c=JSON.parse(readFileSync(process.env.LOOM_CONTEXT,'utf8')); ref=process.env.LOOM_DEFAULT || c.default; } if(!ref && process.env.LOOM_DEFAULT) ref=process.env.LOOM_DEFAULT; const from=resolve(globals.cwd||process.cwd()); let resolved:ResolvedLoom|undefined; if(ref) resolved=resolveLoomRef(ref,from); else resolved=resolveCurrentLoom(from); if(!resolved) throw new LoomError('LOOM_NOT_FOUND','could not resolve Loom; use -L <local-name|id|alias|path> or run loom init'); const cfg=JSON.parse(readFileSync(join(resolved.loom,'loom.json'),'utf8')); return {root: resolved.root, container: resolved.container, loom: resolved.loom, config:cfg}; }
type ResolvedLoom = { root:string; container:string; loom:string };
function findContainer(start:string){ let d=resolve(start); while(true){ const p=join(d,'.loom'); if(existsSync(join(p,'config.json')) && existsSync(join(p,'looms'))) return p; const n=dirname(d); if(n===d) return undefined; d=n; }}
function readCurrent(container:string){ if(!existsSync(join(container,'current'))) return undefined; const s=readFileSync(join(container,'current'),'utf8').trim(); return s||undefined; }
function listLocalLooms(container:string){ const dir=join(container,'looms'); if(!existsSync(dir)) return [] as any[]; return readdirSync(dir,{withFileTypes:true}).filter(d=>d.isDirectory()&&existsSync(join(dir,d.name,'loom.json'))).map(d=>{ const p=join(dir,d.name); const cfg=JSON.parse(readFileSync(join(p,'loom.json'),'utf8')); return {name:d.name,id:cfg.id,title:cfg.title,path:p}; }); }
function localLoomPath(container:string, name:string){ const direct=join(container,'looms',name); if(existsSync(join(direct,'loom.json'))) return direct; const match=listLocalLooms(container).find(l=>l.id===name||l.name===name); return match?.path; }
function resolveCurrentLoom(start:string):ResolvedLoom|undefined{ const container=findContainer(start); if(!container) return undefined; const current=readCurrent(container); if(!current) throw new LoomError('LOOM_NOT_FOUND',`no current Loom selected in ${container}; run loom switch <name>`); const loom=localLoomPath(container,current); if(!loom) throw new LoomError('LOOM_NOT_FOUND',`current Loom ${current} is missing in ${container}`); return {root:dirname(container),container,loom}; }
function resolveLoomRef(ref:string,start:string=process.cwd()):ResolvedLoom{ const p=resolve(ref); if(existsSync(join(p,'loom.json'))){ const container=dirname(dirname(p)); if(basename(dirname(p))!=='looms' || !existsSync(join(container,'config.json'))) throw new LoomError('LOOM_NOT_FOUND',`path is not inside a Loom container: ${ref}`); return {root:dirname(container),container,loom:p}; } if(existsSync(join(p,'.loom','config.json'))){ const r=resolveCurrentLoom(p); if(r) return r; }
  const container=findContainer(start); if(container){ const local=localLoomPath(container,ref); if(local) return {root:dirname(container),container,loom:local}; }
  ensureRegistry(); const rows=regJson(`select * from registry_looms where id=${q(ref)} or alias=${q(ref)};`); if(rows.length>1) throw new LoomError('AMBIGUOUS_LOOM',`ambiguous Loom alias ${ref}`); if(rows.length===1) return resolveLoomRef(rows[0].loom_path,start); throw new LoomError('LOOM_NOT_FOUND',`unknown Loom ${ref}`); }

function lock<T>(c:Ctx, fn:()=>T):T{ const lockDir=join(c.loom,'runtime','loom.lock'); mkdirSync(join(c.loom,'runtime'),{recursive:true}); const start=Date.now(); while(true){ try{ mkdirSync(lockDir); writeFileSync(join(lockDir,'meta.json'),json({pid:process.pid,host:hostname(),command:process.argv.join(' '),time:now()})); break; } catch { if(Date.now()-start>10000){ const info=readLockInfo(c); throw new LoomError('LOCK_TIMEOUT','could not acquire Loom lock',info,5,{fix:`Run: loom -L ${c.loom} lock status --json. If stale, run: loom -L ${c.loom} lock clear-stale`,transient:true}); } Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50); } } try{return fn();} finally{ rmSync(lockDir,{recursive:true,force:true}); } }
function lockPath(c:Ctx){ return join(c.loom,'runtime','loom.lock'); }
function isPidAlive(pid:any){ if(hostname()!==hostname()) return undefined; const n=Number(pid); if(!Number.isFinite(n)||n<=0) return false; try{ process.kill(n,0); return true; }catch{return false;} }
function readLockInfo(c:Ctx){ const path=lockPath(c); if(!existsSync(path)) return {locked:false,path}; let meta:any={}; try{ meta=JSON.parse(readFileSync(join(path,'meta.json'),'utf8')); }catch{} const age_ms=meta.time?Date.now()-Date.parse(meta.time):undefined; return {locked:true,path,meta,age_ms,pid_alive:meta.host===hostname()?isPidAlive(meta.pid):undefined}; }
function cmdLock(c:Ctx,args:string[]){ const sub=args[0]||'status'; if(sub==='status') return outData(readLockInfo(c)); if(sub==='clear-stale'){ const info=readLockInfo(c); if(!info.locked) return outData({cleared:false,reason:'not_locked',lock:info}); if(info.pid_alive===true) throw new LoomError('LOCK_ACTIVE','lock holder process is still alive',info,5,{fix:'Wait for the command to finish or inspect the active process.',transient:true}); if(info.meta?.host && info.meta.host!==hostname()) throw new LoomError('LOCK_FOREIGN_HOST','lock was created on another host; refusing automatic clear',info,5,{fix:`Inspect ${info.path} manually on host ${info.meta.host}.`,transient:false}); rmSync(lockPath(c),{recursive:true,force:true}); return outData({cleared:true,lock:info}); } throw new LoomError('INVALID_ARGUMENT','lock status|clear-stale',undefined,2); }
function writeAtomic(path:string, content:string){ mkdirSync(dirname(path),{recursive:true}); const tmp=`${path}.tmp-${process.pid}-${Date.now()}`; writeFileSync(tmp,content); renameSync(tmp,path); }
function slug(s:string){ return s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,60)||'node'; }
function nextNodeId(c:Ctx){ const nums=listNodes(c).map(n=>Number(n.id.slice(2))).filter(Number.isFinite); const n=Math.max(0,...nums)+1; return formatNodeId(n); }
function formatNodeId(n:number){ return `N-${String(n).padStart(4,'0')}`; }
function nextMsgId(c:Ctx){ ensureRuntime(c.loom); const rows=rtJson(c.loom,`select id from inbox_items;`); const nums=rows.map((r:any)=>Number(String(r.id).slice(2))).filter(Number.isFinite); return `M-${String(Math.max(0,...nums)+1).padStart(4,'0')}`; }

function parseNodeRef(a:string){ const m=a.match(/^(?:([^:]+):)?(N-\d+)$/); if(!m) throw new LoomError('INVALID_REF',`invalid node ref ${a}`); return m[2]; }
function nodePath(c:Ctx,id:string){ const found=readdirSync(join(c.loom,'nodes')).find(f=>f.startsWith(id+'-')&&f.endsWith('.md')); if(!found) throw new LoomError('NODE_NOT_FOUND',`node not found ${id}`,undefined,3); return join(c.loom,'nodes',found); }
function readNode(c:Ctx,id:string){ const path=nodePath(c,id); const raw=readFileSync(path,'utf8'); const m=raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/); if(!m) throw new LoomError('INVALID_FRONTMATTER',`invalid frontmatter ${path}`,{path},6); try { return {path, fm: parseYaml(m[1]), body:m[2]}; } catch(e) { throw frontmatterError(path,e); } }
function writeNode(c:Ctx,fm:Obj,body:string){ fm.updated_at=now(); const path = existsMaybe(c,fm.id) || join(c.loom,'nodes',`${fm.id}-${slug(fm.title)}.md`); writeAtomic(path,`---\n${toYaml(fm)}---\n\n${body}`); return path; }
function existsMaybe(c:Ctx,id:string){ try{return nodePath(c,id);}catch{return undefined;} }
function listNodes(c:Ctx){ const dir=join(c.loom,'nodes'); if(!existsSync(dir)) return [] as any[]; return readdirSync(dir).filter(f=>f.endsWith('.md')).map(f=>{ const path=join(dir,f); try{const raw=readFileSync(path,'utf8'); const m=raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/); if(!m)return null; const fm=parseYaml(m[1]); return {path, fm, body:m[2], id:fm.id};}catch(e){ throw frontmatterError(path,e); }}).filter(Boolean) as any[]; }

function parseYaml(src:string):Obj{ const o:Obj={}; const lines=src.split(/\r?\n/); for(let i=0;i<lines.length;i++){ const line=lines[i]; if(!line.trim()) continue; const m=line.match(/^([A-Za-z0-9_]+):(?:\s*(.*))?$/); if(!m) continue; const key=m[1], val=m[2]??''; if(val===''){ const arr:any[]=[]; while(i+1<lines.length && lines[i+1].startsWith('  - ')){ i++; const rest=lines[i].slice(4); const im=rest.match(/^([^:]+):\s*(.*)$/); if(im){ const item:Obj={}; item[im[1]]=parseScalar(im[2]); while(i+1<lines.length && lines[i+1].startsWith('    ')){ i++; const sm=lines[i].trim().match(/^([^:]+):\s*(.*)$/); if(sm) item[sm[1]]=parseScalar(sm[2]); } arr.push(item); } else { arr.push(parseScalar(rest)); } } o[key]=arr; } else o[key]=parseScalar(val); } return o; }
function parseScalar(v:string):any{ v=v.trim(); if(v==='null')return null; if(v==='true')return true; if(v==='false')return false; if(v.startsWith('[')&&v.endsWith(']')) return v.slice(1,-1).split(',').map(s=>parseScalar(s.trim())).filter(v=>v!==undefined&&v!==''); return v.replace(/^"|"$/g,''); }
function yamlScalar(v:any){ if(v===null)return 'null'; if(typeof v==='boolean')return v?'true':'false'; const s=String(v); return /[:#\[\]{}]|^\s|\s$/.test(s) ? `"${s.replaceAll('\\','\\\\').replaceAll('"','\\"')}"` : s; }
function toYaml(o:Obj){ let s=''; for(const [k,v] of Object.entries(o)){ if(v===undefined) continue; if(Array.isArray(v)){ if(v.length===0){s+=`${k}: []\n`; continue;} s+=`${k}:\n`; for(const it of v){ if(it && typeof it==='object' && !Array.isArray(it)){ const es=Object.entries(it); if(es.length===0){ s+=`  - {}\n`; continue; } s+=`  - ${es[0][0]}: ${yamlScalar(es[0][1])}\n`; for(const [kk,vv] of es.slice(1)) s+=`    ${kk}: ${yamlScalar(vv)}\n`; } else s+=`  - ${yamlScalar(it)}\n`; } } else s+=`${k}: ${yamlScalar(v)}\n`; } return s; }
function frontmatterError(path:string,e:unknown):LoomError{ if(e instanceof LoomError) return e; const message=e instanceof Error?e.message:String(e); return new LoomError('INVALID_FRONTMATTER',`invalid frontmatter in ${path}: ${message}`,{path,cause:message},6); }
function bodyFor(title:string, summary=''){ return `# Summary\n\n${summary||title}\n\n# Context\n\n\n# Analysis\n\n\n# Result\n\nPending.\n`; }
function appendEvent(c:Ctx,e:Obj){ e.event_id=e.event_id||`E-${Date.now()}-${Math.random().toString(36).slice(2,6)}`; e.time=e.time||now(); writeFileSync(join(c.loom,'events.jsonl'), json(e)+'\n', {flag:'a'}); return e.event_id; }

function cmdCreate(c:Ctx,args:string[]){ lock(c,()=>{ const title=stripFlags(args,['--kind','--parent','--summary','--tag'])[0]; if(!title) throw new LoomError('INVALID_ARGUMENT','title required',undefined,2); const id=nextNodeId(c); const tags:string[]=[]; for(let i=0;i<args.length;i++) if(args[i]==='--tag') tags.push(args[i+1]); const fm:any={id,title,kind:flag(args,'--kind','task'),state:'open',parent:flag(args,'--parent')||null,summary:flag(args,'--summary')||title,tags,created_at:now(),updated_at:now()}; writeNode(c,fm,bodyFor(title,fm.summary)); const ev=appendEvent(c,{type:'node.created',node_id:id,title,kind:fm.kind}); rebuildIndex(c); outData({node:summary(c,fm), event_id:ev}); }); }
function cmdShow(c:Ctx,args:string[]){ const id=parseNodeRef(args[0]||''); const n=readNode(c,id); outData({node:summary(c,n.fm), frontmatter:n.fm, body:n.body}); }
function summary(c:Ctx,fm:Obj){ return {id:fm.id,title:fm.title,kind:fm.kind,state:fm.state,parent:fm.parent??null,summary:fm.summary,path:existsMaybe(c,fm.id)||''}; }
function cmdNode(c:Ctx,args:string[]){ const sub=args[0]; if(sub==='create'){ rejectUnknownFlags(args.slice(1),['--title','--kind','--parent','--summary','--tag','--state']); const title=flag(args,'--title')||positionalAfter(args.slice(1),['--kind','--parent','--summary','--tag','--state']).join(' '); return cmdCreate(c,[title,...args.slice(1).filter(a=>a!=='--title'&&a!==title)]); } if(sub==='show') return cmdShow(c,args.slice(1)); if(sub==='list'){ rejectUnknownFlags(args.slice(1),['--kind','--state','--parent']); return cmdNodeList(c,args.slice(1)); } if(sub==='update'){ rejectUnknownFlags(args.slice(1),['--title','--kind','--state','--parent','--summary','--tag']); return cmdNodeUpdate(c,args.slice(1)); } throw new LoomError('INVALID_ARGUMENT','node create|show|update|list',undefined,2); }
function cmdNodeList(c:Ctx,args:string[]){ const kind=flag(args,'--kind'); const state=flag(args,'--state'); const parentRaw=flag(args,'--parent'); const parent=parentRaw==='none'?null:parentRaw; const nodes=listNodes(c).map(n=>summary(c,n.fm)).filter((n:any)=>(!kind||n.kind===kind)&&(!state||n.state===state)&&(parentRaw===undefined||n.parent===parent)); outData({nodes}); }
function cmdNodeUpdate(c:Ctx,args:string[]){ lock(c,()=>{ const id=parseNodeRef(args[0]||''); const n=readNode(c,id); const oldPath=n.path; if(flag(args,'--title')) n.fm.title=flag(args,'--title'); if(flag(args,'--kind')) n.fm.kind=flag(args,'--kind'); if(flag(args,'--state')) n.fm.state=flag(args,'--state'); if(flag(args,'--summary')) n.fm.summary=flag(args,'--summary'); if(args.includes('--parent')){ const p=flag(args,'--parent'); n.fm.parent=p==='none'?null:p; } const tags:string[]=[]; for(let i=0;i<args.length;i++) if(args[i]==='--tag') tags.push(args[i+1]); if(tags.length) n.fm.tags=tags; const newPath=writeNode(c,n.fm,n.body); if(newPath!==oldPath && existsSync(oldPath)) rmSync(oldPath,{force:true}); const ev=appendEvent(c,{type:'node.updated',node_id:id}); rebuildIndex(c); outData({node:summary(c,n.fm),event_id:ev}); }); }
function cmdEdge(c:Ctx,args:string[]){ const sub=args[0]; if(sub==='add'){ rejectUnknownFlags(args.slice(1),['--to','--type']); return cmdLink(c,args.slice(1)); } if(sub==='list') return cmdEdgeList(c,args.slice(1)); if(sub==='types') return outData({types:EDGE_TYPES}); throw new LoomError('INVALID_ARGUMENT','edge add|list|types',undefined,2); }
const EDGE_TYPES=['depends_on','blocks','reviews','validates','implements','references','critiques','chooses','supersedes','duplicates','related'];
function cmdEdgeList(c:Ctx,args:string[]){ const node=args[0]&&!args[0].startsWith('--')?parseNodeRef(args[0]):undefined; const edges=listNodes(c).flatMap(n=>(n.fm.edges||[]).map((e:any)=>({from:n.fm.id,type:e.type,to:e.to,label:e.label}))).filter((e:any)=>!node||e.from===node||String(e.to).split(':').pop()===node); outData({edges}); }
function cmdTree(c:Ctx,args:string[]){ const root=args[0]?parseNodeRef(args[0]):null; const nodes=listNodes(c).map(n=>n.fm); const rec=(pid:any,depth=0):string[]=>nodes.filter(n=>(n.parent??null)===(pid??null)).flatMap(n=>[`${'  '.repeat(depth)}${n.id} ${n.title} [${n.kind}/${n.state}]`,...rec(n.id,depth+1)]); out(globalJson?json({ok:true,status:'ok',data:{lines:rec(root)},warnings:[],next_steps:[]}):rec(root).join('\n')); }
function createChild(c:Ctx,parent:string,title:string,kind:string,edge?:Obj){ const id=nextNodeId(c); const fm:any={id,title,kind,state:'open',parent,summary:title,tags:[],edges:edge?[edge]:[],created_at:now(),updated_at:now()}; writeNode(c,fm,bodyFor(title)); return id; }
function cmdDecompose(c:Ctx,args:string[]){ lock(c,()=>{ const src=parseNodeRef(args[0]); const ids=args.slice(1).map(t=>createChild(c,src,t,'task')); const ev=appendEvent(c,{type:'node.decomposed',source:src,children:ids}); rebuildIndex(c); outData({source:src, children:ids, event_id:ev}); }); }
function cmdBranch(c:Ctx,args:string[]){ lock(c,()=>{ const src=parseNodeRef(args[0]); const ids=args.slice(1).map(t=>createChild(c,src,t,'variant',{type:'variant_of',to:src})); const ev=appendEvent(c,{type:'node.branched',source:src,variants:ids}); rebuildIndex(c); outData({source:src, variants:ids, event_id:ev}); }); }
function cmdLink(c:Ctx,args:string[]){ lock(c,()=>{ const from=parseNodeRef(args[0]); const to=flag(args,'--to'); const type=flag(args,'--type','references'); if(!to) throw new LoomError('INVALID_ARGUMENT','--to required',undefined,2); const n=readNode(c,from); const edges=n.fm.edges||[]; const duplicate=edges.some((e:any)=>e.type===type && e.to===to); let ev:string|undefined; if(!duplicate){ n.fm.edges=[...edges,{type,to}]; writeNode(c,n.fm,n.body); ev=appendEvent(c,{type:'edge.added',from,to,edge_type:type}); rebuildIndex(c); } outData({from,to,type,created:!duplicate,duplicate,event_id:ev}); }); }
function cmdDecide(c:Ctx,args:string[]){ lock(c,()=>{ const src=parseNodeRef(args[0]); const chosen=flag(args,'--choose'); if(!chosen) throw new LoomError('INVALID_ARGUMENT','--choose required',undefined,2); const title=`Decision: ${readNode(c,src).fm.title}`; const id=nextNodeId(c); const fm:any={id,title,kind:'decision',state:'resolved',parent:src,summary:flag(args,'--summary')||`Choose ${chosen}`,edges:[{type:'chooses',to:chosen}],resolution:'chosen',created_at:now(),updated_at:now()}; writeNode(c,fm,bodyFor(title,fm.summary).replace('Pending.',fm.summary)); const ev=appendEvent(c,{type:'node.created',node_id:id,title,kind:'decision'}); rebuildIndex(c); outData({node:summary(c,fm), chosen, event_id:ev}); }); }
function cmdResolve(c:Ctx,args:string[]){ lock(c,()=>{ const id=parseNodeRef(args[0]); const n=readNode(c,id); n.fm.state='resolved'; n.fm.resolution=flag(args,'--resolution','answered'); n.fm.summary=flag(args,'--summary',n.fm.summary||'Resolved'); const body=n.body+`\n\n# Resolution ${now()}\n\n${n.fm.summary}\n`; writeNode(c,n.fm,body); const ev=appendEvent(c,{type:'node.resolved',node_id:id,resolution:n.fm.resolution}); rebuildIndex(c); routeUpdate(c,id,n.fm.summary); outData({node:summary(c,n.fm), event_id:ev}); }); }
function cmdNote(c:Ctx,args:string[]){ const sub=args[0]; if(sub==='add') return cmdNoteAppend(c,args.slice(1)); if(sub==='list') return cmdNoteList(c,args.slice(1)); if(sub==='retract') return cmdNoteRetract(c,args.slice(1)); throw new LoomError('INVALID_ARGUMENT','note add|list|retract',undefined,2); }
function cmdNoteAppend(c:Ctx,args:string[]){ rejectUnknownFlags(args.slice(1),['--stdin']); lock(c,()=>{ const id=parseNodeRef(args[0]); const msg=readNoteMessage(args.slice(1)); const n=readNode(c,id); writeNode(c,n.fm,n.body+`\n\n# Note ${now()}\n\n${msg}\n`); const ev=appendEvent(c,{type:'node.updated',node_id:id}); rebuildIndex(c); outData({node:summary(c,n.fm), event_id:ev}); }); }
function cmdNoteList(c:Ctx,args:string[]){ const id=parseNodeRef(args[0]); const n=readNode(c,id); outData({node:id,notes:extractNotes(id,n.body).map(n=>({id:n.id,created_at:n.created_at,body:n.body}))}); }
function cmdNoteRetract(c:Ctx,args:string[]){ lock(c,()=>{ const ref=args[0]||''; const m=ref.match(/^(N-\d+):note:(\d+)$/); if(!m) throw new LoomError('INVALID_REF','expected note ref like N-0001:note:1',undefined,2); const node=m[1]; const idx=Number(m[2]); const reason=flag(args,'--reason','retracted'); const n=readNode(c,node); const notes=extractNotes(node,n.body); const target=notes[idx-1]; if(!target) throw new LoomError('NOTE_NOT_FOUND',`note not found ${ref}`,undefined,3); const body=n.body.slice(0,target.start)+`\n\n# Note Retraction ${now()}\n\nRetracted ${ref}: ${reason}\n`+n.body.slice(target.end); writeNode(c,n.fm,body); const ev=appendEvent(c,{type:'node.updated',node_id:node,note_retracted:ref}); rebuildIndex(c); outData({retracted:ref,node,event_id:ev}); }); }
function extractNotes(node:string, body:string){ return [...body.matchAll(/^# Note ([^\n]+)\n\n([\s\S]*?)(?=\n# |$)/gm)].map((m,i)=>({id:`${node}:note:${i+1}`,created_at:m[1],body:m[2].trimEnd(),start:m.index??0,end:(m.index??0)+m[0].length})); }
function readNoteMessage(args:string[]){ const rest=args.filter(a=>a!=='--stdin'); if(args.includes('--stdin') || rest.length===0){ const input=readFileSync(0,'utf8'); if(!input.trim()) throw new LoomError('INVALID_ARGUMENT','note message required on stdin or as arguments',undefined,2); return input.trimEnd(); } return rest.join(' '); }

type PatchMode = 'validate'|'preview'|'apply';
type PatchPlan = { mode:PatchMode; dryRun:boolean; scope:string|null; localRefs:Obj; operations:any[]; summary:Obj; warnings:any[] };
function cmdPatch(c:Ctx,args:string[]){
  const sub=args[0] as PatchMode;
  rejectUnknownFlags(args.slice(1),['--stdin','--scope','--dry-run']);
  if(!['validate','preview','apply'].includes(sub)) throw new LoomError('INVALID_ARGUMENT','patch validate|preview|apply',undefined,2);
  if(!has(args,'--stdin')) throw new LoomError('INVALID_ARGUMENT','patch requires --stdin',undefined,2);
  const dryRun = sub!=='apply' || has(args,'--dry-run');
  const scope = flag(args,'--scope');
  const runPatch = () => {
    const patch = parsePatchInput(readFileSync(0,'utf8'));
    const plan = buildPatchPlan(c, patch, sub, dryRun, scope);
    if(!dryRun) applyPatchPlan(c, plan);
    outData(plan);
  };
  if(dryRun) return runPatch();
  return lock(c, runPatch);
}
function parsePatchInput(src:string){
  if(!src.trim()) throw new LoomError('INVALID_ARGUMENT','patch JSON required on stdin',undefined,2);
  try{return JSON.parse(src);}catch(e){ throw new LoomError('INVALID_ARGUMENT','patch input must be JSON',e instanceof Error?e.message:String(e),2); }
}
function patchOps(patch:any):any[]{ const ops=Array.isArray(patch)?patch:patch?.operations; if(!Array.isArray(ops)) throw new LoomError('INVALID_ARGUMENT','patch must be an array or object with operations array',undefined,2); return ops; }
function buildPatchPlan(c:Ctx, patch:any, mode:PatchMode, dryRun:boolean, scopeArg?:string):PatchPlan{
  const existing=listNodes(c).map(n=>n.fm);
  const existingIds=new Set(existing.map(n=>n.id));
  const byId=new Map(existing.map(n=>[n.id,n]));
  const scope=scopeArg?parseNodeRef(scopeArg):null;
  if(scope && !existingIds.has(scope)) throw new LoomError('NODE_NOT_FOUND',`scope not found ${scope}`,undefined,3);
  const inScope=new Set(scope?[scope,...descendants(existing,scope)]:existing.map(n=>n.id));
  const localRefs:Obj={};
  const operations:any[]=[];
  const touched=new Set<string>();
  let created=0, notes=0, edges=0, references=0;
  let nextNum=Math.max(0,...[...existingIds].map(id=>Number(id.slice(2))).filter(Number.isFinite))+1;
  const resolvePatchRef=(v:any, field:string) => {
    if(typeof v!=='string' || !v) throw new LoomError('INVALID_ARGUMENT',`${field} node ref required`,undefined,2);
    if(localRefs[v]) return localRefs[v];
    if(v.startsWith('$') && localRefs[v.slice(1)]) return localRefs[v.slice(1)];
    return parseNodeRef(v);
  };
  const assertInScope=(id:string, what:string) => { if(scope && !inScope.has(id)) throw new LoomError('SCOPE_VIOLATION',`${what} ${id} is outside scope ${scope}`,{scope,node:id},2); };
  for(const [index,op] of patchOps(patch).entries()){
    const kind=String(op.op||op.type||'');
    if(kind==='create_node'||kind==='create'){
      const title=op.title;
      if(typeof title!=='string'||!title.trim()) throw new LoomError('INVALID_ARGUMENT',`operation ${index}: title required`,undefined,2);
      const parent = op.parent===undefined||op.parent===null ? null : resolvePatchRef(op.parent,'parent');
      if(scope){ if(!parent) throw new LoomError('SCOPE_VIOLATION',`operation ${index}: scoped create_node requires parent inside scope`,{scope},2); assertInScope(parent,'parent'); }
      if(parent && !existingIds.has(parent) && !Object.values(localRefs).includes(parent)) throw new LoomError('NODE_NOT_FOUND',`parent not found ${parent}`,undefined,3);
      const id=formatNodeId(nextNum++);
      const ref=op.local_ref||op.localRef||op.ref||op.id;
      if(ref){ const k=String(ref); if(localRefs[k]||localRefs[`$${k}`]) throw new LoomError('INVALID_ARGUMENT',`duplicate local ref ${k}`,undefined,2); localRefs[k]=id; if(!k.startsWith('$')) localRefs[`$${k}`]=id; }
      const fm:any={id,title,kind:op.kind||'task',state:op.state||'open',parent,summary:op.summary||title,tags:Array.isArray(op.tags)?op.tags:[],created_at:null,updated_at:null};
      if(scope) inScope.add(id);
      existingIds.add(id); byId.set(id,fm); touched.add(id); created++;
      operations.push({index,op:'create_node',id,parent,title,kind:fm.kind,state:fm.state,summary:fm.summary,tags:fm.tags,local_ref:ref||null});
    } else if(kind==='add_note'||kind==='note'){
      const id=resolvePatchRef(op.node||op.id||op.to,'node'); assertInScope(id,'node'); if(!existingIds.has(id)) throw new LoomError('NODE_NOT_FOUND',`node not found ${id}`,undefined,3);
      const message=op.message||op.body||op.text; if(typeof message!=='string'||!message.trim()) throw new LoomError('INVALID_ARGUMENT',`operation ${index}: note message required`,undefined,2);
      touched.add(id); notes++; operations.push({index,op:'add_note',node:id,message});
    } else if(kind==='add_edge'||kind==='edge'){
      const from=resolvePatchRef(op.from||op.node,'from'); const to=resolvePatchRef(op.to,'to');
      assertInScope(from,'edge from'); assertInScope(to,'edge to');
      if(!existingIds.has(from)) throw new LoomError('NODE_NOT_FOUND',`from node not found ${from}`,undefined,3);
      if(!existingIds.has(to)) throw new LoomError('NODE_NOT_FOUND',`to node not found ${to}`,undefined,3);
      touched.add(from); edges++; operations.push({index,op:'add_edge',from,to,type:op.edge_type||op.edgeType||op.type||'references',label:op.label});
    } else if(kind==='add_reference'||kind==='reference'){
      const id=resolvePatchRef(op.node||op.id,'node'); assertInScope(id,'node'); if(!existingIds.has(id)) throw new LoomError('NODE_NOT_FOUND',`node not found ${id}`,undefined,3);
      if(typeof op.path!=='string'||!op.path) throw new LoomError('INVALID_ARGUMENT',`operation ${index}: reference path required`,undefined,2);
      touched.add(id); references++; operations.push({index,op:'add_reference',node:id,workspace:op.workspace||'',path:op.path,label:op.label||op.path,kind:op.kind||'source'});
    } else throw new LoomError('INVALID_ARGUMENT',`operation ${index}: unsupported patch op ${kind}`,undefined,2);
  }
  return {mode,dryRun,scope,localRefs,operations,summary:{created,notes,edges,references,touched_nodes:[...touched]},warnings:[]};
}
function draftDir(c:Ctx){ const d=join(c.loom,'runtime','drafts'); mkdirSync(d,{recursive:true}); return d; }
function nextDraftId(c:Ctx){ const nums=readdirSync(draftDir(c)).map(f=>Number((f.match(/^D-(\d+)\.json$/)||[])[1])).filter(Number.isFinite); return `D-${String(Math.max(0,...nums)+1).padStart(4,'0')}`; }
function draftPath(c:Ctx,id:string){ return join(draftDir(c),`${id}.json`); }
function readDraft(c:Ctx,id:string){ const p=draftPath(c,id); if(!existsSync(p)) throw new LoomError('DRAFT_NOT_FOUND',`draft not found ${id}`,undefined,3); return JSON.parse(readFileSync(p,'utf8')); }
function cmdDraft(c:Ctx,args:string[]){ const sub=args[0]; if(sub==='create') return cmdDraftCreate(c,args.slice(1)); if(sub==='list') return cmdDraftList(c); if(sub==='show') return outData({draft:readDraft(c,args[1])}); if(sub==='discard') return cmdDraftDiscard(c,args.slice(1)); if(sub==='commit') return cmdDraftCommit(c,args.slice(1)); throw new LoomError('INVALID_ARGUMENT','draft create|list|show|commit|discard',undefined,2); }
function cmdDraftCreate(c:Ctx,args:string[]){ rejectUnknownFlags(args,['--stdin','--scope','--title']); if(!has(args,'--stdin')) throw new LoomError('INVALID_ARGUMENT','draft create requires --stdin',undefined,2); const patch=parsePatchInput(readFileSync(0,'utf8')); const scope=flag(args,'--scope'); const plan=buildPatchPlan(c,patch,'preview',true,scope); const id=nextDraftId(c); const draft={id,title:flag(args,'--title',id),scope:scope||null,patch,plan,created_at:now(),updated_at:now()}; writeAtomic(draftPath(c,id),JSON.stringify(draft,null,2)+'\n'); outData({draft}); }
function cmdDraftList(c:Ctx){ const drafts=readdirSync(draftDir(c)).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(readFileSync(join(draftDir(c),f),'utf8'))).map(d=>({id:d.id,title:d.title,scope:d.scope,created_at:d.created_at,updated_at:d.updated_at,summary:d.plan?.summary})); outData({drafts}); }
function cmdDraftDiscard(c:Ctx,args:string[]){ const id=args[0]; const p=draftPath(c,id); if(!existsSync(p)) throw new LoomError('DRAFT_NOT_FOUND',`draft not found ${id}`,undefined,3); unlinkSync(p); outData({discarded:id}); }
function cmdDraftCommit(c:Ctx,args:string[]){ const id=args[0]; const draft=readDraft(c,id); return lock(c,()=>{ const plan=buildPatchPlan(c,draft.patch,'apply',false,draft.scope||undefined); applyPatchPlan(c,plan); unlinkSync(draftPath(c,id)); outData({draft_id:id,committed:true,plan}); }); }
function applyPatchPlan(c:Ctx, plan:PatchPlan){
  const written=new Set<string>();
  const events:string[]=[];
  for(const op of plan.operations){
    if(op.op==='create_node'){
      const fm:any={id:op.id,title:op.title,kind:op.kind,state:op.state||'open',parent:op.parent,summary:op.summary||op.title,tags:op.tags||[],created_at:now(),updated_at:now()};
      writeNode(c,fm,bodyFor(op.title,fm.summary));
      events.push(appendEvent(c,{type:'node.created',node_id:op.id,title:op.title,kind:op.kind}));
      written.add(op.id);
    } else if(op.op==='add_note'){
      const n=readNode(c,op.node); writeNode(c,n.fm,n.body+`\n\n# Note ${now()}\n\n${op.message}\n`);
      events.push(appendEvent(c,{type:'node.updated',node_id:op.node})); written.add(op.node);
    } else if(op.op==='add_edge'){
      const n=readNode(c,op.from); const edge:any={type:op.type,to:op.to}; if(op.label) edge.label=op.label;
      const es=n.fm.edges||[]; if(!es.some((e:any)=>e.type===edge.type&&e.to===edge.to&&e.label===edge.label)){ n.fm.edges=[...es,edge]; writeNode(c,n.fm,n.body); events.push(appendEvent(c,{type:'edge.added',from:op.from,to:op.to,edge_type:op.type})); written.add(op.from); }
    } else if(op.op==='add_reference'){
      const n=readNode(c,op.node); const ref={workspace:op.workspace,path:op.path,label:op.label,kind:op.kind}; const refs=n.fm.references||[];
      const dup=refs.some((r:any)=>(r.workspace||'')===ref.workspace&&r.path===ref.path&&r.label===ref.label&&r.kind===ref.kind);
      if(!dup){ n.fm.references=[...refs,ref]; writeNode(c,n.fm,n.body); events.push(appendEvent(c,{type:'node.updated',node_id:op.node})); written.add(op.node); }
    }
  }
  rebuildIndex(c);
  plan.summary.applied=true; plan.summary.written_nodes=[...written]; plan.summary.event_ids=events;
}

function cmdIndex(c:Ctx,args:string[]){ if(args[0]!=='rebuild') throw new LoomError('INVALID_ARGUMENT','expected index rebuild',undefined,2); lock(c,()=>{ rebuildIndex(c); outData({rebuilt:true}); }); }
function ensureIndex(loom:string){ sqlite(join(loom,'index.sqlite'),`pragma user_version=1; create table if not exists nodes(id text primary key, slug text, title text, kind text, state text, parent_id text, summary text, body text, path text, created_at text, updated_at text); create table if not exists edges(from_loom_id text, from_node_id text, to_loom_id text, to_node_id text, type text, label text, created_at text); create table if not exists chunks(id text primary key,node_id text,heading_path text,text text,start_line integer,end_line integer); create table if not exists node_files(node_id text,role text,workspace text,path text,label text,kind text); create table if not exists node_closure(ancestor_id text,descendant_id text,depth integer); create virtual table if not exists chunks_fts using fts5(node_id, title, text);`); }
function rebuildIndex(c:Ctx){ ensureIndex(c.loom); const db=join(c.loom,'index.sqlite'); sqlite(db,'delete from nodes; delete from edges; delete from chunks; delete from node_files; delete from node_closure; delete from chunks_fts;'); const ns=listNodes(c); for(const n of ns){ const fm=n.fm, body=n.body; sqlite(db,`insert into nodes values(${q(fm.id)},${q(slug(fm.title))},${q(fm.title)},${q(fm.kind)},${q(fm.state)},${q(fm.parent||'')},${q(fm.summary||'')},${q(body)},${q(relative(c.loom,n.path))},${q(fm.created_at||'')},${q(fm.updated_at||'')});`); for(const e of fm.edges||[]) sqlite(db,`insert into edges values(${q(c.config.id)},${q(fm.id)},${q(String(e.to).includes(':')?String(e.to).split(':')[0]:c.config.id)},${q(String(e.to).split(':').pop()||'')},${q(e.type)},${q(e.label||'')},${q(fm.updated_at||'')});`); for(const a of fm.artifacts||[]) sqlite(db,`insert into node_files values(${q(fm.id)},'artifact',null,${q(a.path)},${q(a.label||'')},${q(a.kind||'')});`); for(const r of fm.references||[]) sqlite(db,`insert into node_files values(${q(fm.id)},'reference',${q(r.workspace||'')},${q(r.path)},${q(r.label||'')},${q(r.kind||'')});`); sqlite(db,`insert into chunks values(${q(fm.id+':body')},${q(fm.id)},'',${q(body)},1,null); insert into chunks_fts(node_id,title,text) values(${q(fm.id)},${q(fm.title)},${q(body)});`); } for(const n of ns){ let d=0, cur=n.fm.parent; while(cur){ d++; sqlite(db,`insert into node_closure values(${q(cur)},${q(n.fm.id)},${d});`); const p=ns.find(x=>x.fm.id===cur); cur=p?.fm.parent; } } }
function cmdSearch(c:Ctx,args:string[]){ ensureIndex(c.loom); const query=args.filter(a=>!a.startsWith('--') && a!==flag(args,'--under') && a!==flag(args,'--kind') && a!==flag(args,'--state')).join(' '); const under=flag(args,'--under'); let sql=`select nodes.*, bm25(chunks_fts) as score, snippet(chunks_fts,2,'[',']','...',12) as snippet from chunks_fts join nodes on nodes.id=chunks_fts.node_id where chunks_fts match ${q(query||'*')}`; if(under) sql+=` and nodes.id in (select descendant_id from node_closure where ancestor_id=${q(parseNodeRef(under))})`; sql+=' limit 20;'; const rows=dbJson(join(c.loom,'index.sqlite'),sql); outData({query, hits:rows.map((r:any)=>({node:{id:r.id,title:r.title,kind:r.kind,state:r.state,parent:r.parent_id||null,path:r.path},score:r.score,snippet:r.snippet}))}); }
function cmdContext(c:Ctx,args:string[]){ const id=parseNodeRef(args[0]); const brief=has(args,'--brief'); const n=readNode(c,id); const nodes=listNodes(c).map(x=>x.fm); const ancestors=[]; let cur=n.fm.parent; while(cur){ const p=nodes.find(x=>x.id===cur); if(!p) break; ancestors.unshift({id:p.id,title:p.title,summary:p.summary}); cur=p.parent; } const children=nodes.filter(x=>x.parent===id).map(x=>({id:x.id,title:x.title,kind:x.kind,state:x.state,summary:x.summary})); const data:any={loom:{id:c.config.id,alias:c.config.name,root:c.root,workspaces:c.config.workspaces||[]},node:summary(c,n.fm),ancestors,children,links:n.fm.edges||[],artifacts:n.fm.artifacts||[],references:n.fm.references||[]}; if(brief){ data.body_preview=n.body.slice(0,500); data.body_omitted=n.body.length>500; } else data.body=n.body; outData(data); }
function cmdGraph(c:Ctx,args:string[]){ const sub=args[0]||'summary'; if(sub==='summary') return graphSummary(c,args.slice(1)); if(sub==='doctor') return graphDoctor(c,args.slice(1)); throw new LoomError('INVALID_ARGUMENT','graph summary|doctor',undefined,2); }
function graphSummary(c:Ctx,args:string[]){ const root=args[0]&&!args[0].startsWith('--')?parseNodeRef(args[0]):flag(args,'--scope'); const ns=listNodes(c).map(n=>n.fm); const included=root?new Set([root,...descendants(ns,root)]):new Set(ns.map(n=>n.id)); const nodes=ns.filter(n=>included.has(n.id)); const byKind=countBy(nodes,n=>n.kind||'unknown'); const byState=countBy(nodes,n=>n.state||'unknown'); const edges=nodes.flatMap(n=>(n.edges||[]).map((e:any)=>({from:n.id,type:e.type,to:e.to}))); const children=root?nodes.filter(n=>n.parent===root).map(n=>({id:n.id,title:n.title,kind:n.kind,state:n.state,summary:n.summary})):[]; outData({scope:root||null,counts:{nodes:nodes.length,edges:edges.length,byKind,byState},children,edges}); }
function graphDoctor(c:Ctx,args:string[]){ const scope=flag(args,'--scope') || (args[0]&&!args[0].startsWith('--')?parseNodeRef(args[0]):undefined); const ns=listNodes(c).map(n=>n.fm); const ids=new Set(ns.map(n=>n.id)); const included=scope?new Set([scope,...descendants(ns,scope)]):new Set(ns.map(n=>n.id)); const findings:any[]=[]; const seenEdges=new Set<string>(); for(const n of ns){ if(scope&&!included.has(n.id)) continue; if(n.parent && !ids.has(n.parent)) findings.push({severity:'error',code:'MISSING_PARENT',node:n.id,parent:n.parent}); for(const r of n.references||[]) if(r.workspace==='undefined') findings.push({severity:'warning',code:'UNDEFINED_WORKSPACE_REFERENCE',node:n.id,path:r.path}); for(const e of n.edges||[]){ const to=String(e.to).split(':').pop()||''; const key=`${n.id}|${e.type}|${e.to}`; if(seenEdges.has(key)) findings.push({severity:'warning',code:'DUPLICATE_EDGE',from:n.id,type:e.type,to:e.to}); seenEdges.add(key); if(!String(e.to).includes(':') && !ids.has(to)) findings.push({severity:'error',code:'BROKEN_EDGE',from:n.id,type:e.type,to:e.to}); if(scope && (!included.has(n.id) || !included.has(to))) findings.push({severity:'warning',code:'CROSS_SCOPE_EDGE',scope,from:n.id,type:e.type,to:e.to}); } }
  for(const cyc of dependencyCycles(ns)) findings.push({severity:'error',code:'DEPENDENCY_CYCLE',cycle:cyc});
  outData({scope:scope||null,ok:findings.filter(f=>f.severity==='error').length===0,findings}); }
function descendants(ns:Obj[], root:string){ const out:string[]=[]; const visit=(id:string)=>{ for(const n of ns.filter(x=>x.parent===id)){ out.push(n.id); visit(n.id); } }; visit(root); return out; }
function countBy<T>(xs:T[], f:(x:T)=>string){ const o:Obj={}; for(const x of xs){ const k=f(x); o[k]=(o[k]||0)+1; } return o; }
function dependencyCycles(ns:Obj[]){ const dep=new Map<string,string[]>(); for(const n of ns) dep.set(n.id,(n.edges||[]).filter((e:any)=>e.type==='depends_on').map((e:any)=>String(e.to).split(':').pop()||'')); const cycles:string[][]=[]; const stack:string[]=[]; const visiting=new Set<string>(); const visited=new Set<string>(); const dfs=(id:string)=>{ if(visiting.has(id)){ cycles.push(stack.slice(stack.indexOf(id)).concat(id)); return; } if(visited.has(id)) return; visiting.add(id); stack.push(id); for(const to of dep.get(id)||[]) if(dep.has(to)) dfs(to); stack.pop(); visiting.delete(id); visited.add(id); }; for(const id of dep.keys()) dfs(id); return cycles; }

function cmdArtifact(c:Ctx,args:string[]){ const sub=args[0]; if(sub==='list'){ const n=readNode(c,parseNodeRef(args[1])); return outData({artifacts:n.fm.artifacts||[]}); } if(sub!=='add') throw new LoomError('INVALID_ARGUMENT','artifact add|list',undefined,2); lock(c,()=>{ const id=parseNodeRef(args[1]); const src=args[2]; const n=readNode(c,id); const destRel=relative(c.root, join(c.loom,'artifacts',id,basename(src))); const dest=join(c.root,destRel); if(has(args,'--copy')){ mkdirSync(dirname(dest),{recursive:true}); copyFileSync(resolve(src),dest); } n.fm.artifacts=[...(n.fm.artifacts||[]),{path:destRel,label:flag(args,'--label')||basename(src),kind:flag(args,'--kind')||'artifact'}]; writeNode(c,n.fm,n.body); rebuildIndex(c); outData({artifacts:n.fm.artifacts}); }); }
function cmdReference(c:Ctx,args:string[]){ const sub=args[0]; if(sub==='list'){ const n=readNode(c,parseNodeRef(args[1])); return outData({references:n.fm.references||[]}); } if(sub!=='add') throw new LoomError('INVALID_ARGUMENT','reference add|list',undefined,2); lock(c,()=>{ const id=parseNodeRef(args[1]); const pathArg=positionalAfter(args.slice(2), ['--workspace','--label','--kind'])[0]; if(!pathArg) throw new LoomError('INVALID_ARGUMENT','reference path required',undefined,2); const n=readNode(c,id); const original=readFileSync(n.path,'utf8'); const ref={workspace:flag(args,'--workspace',''),path:pathArg,label:flag(args,'--label')||pathArg,kind:flag(args,'--kind')||'source'}; const refs=n.fm.references||[]; const normWs=(v:any)=>v===undefined||v===null||v==='undefined'?'':String(v); const duplicate=refs.some((r:any)=>normWs(r.workspace)===normWs(ref.workspace)&&r.path===ref.path&&r.label===ref.label&&r.kind===ref.kind); if(!duplicate){ n.fm.references=[...refs,ref]; writeNode(c,n.fm,n.body); try{ rebuildIndex(c); }catch(e){ writeAtomic(n.path,original); try{ rebuildIndex(c); }catch{} throw e; } } outData({references:n.fm.references||refs,created:!duplicate,duplicate}); }); }

function positionalAfter(args:string[], flagsWithValues:string[]){ const out:string[]=[]; for(let i=0;i<args.length;i++){ if(flagsWithValues.includes(args[i])) { i++; continue; } if(args[i].startsWith('-')) continue; out.push(args[i]); } return out; }

function ensureRuntime(loom:string){ mkdirSync(join(loom,'runtime'),{recursive:true}); sqlite(join(loom,'runtime','runtime.sqlite'),`pragma user_version=1; create table if not exists inbox_items(id text primary key, recipient_agent_id text not null,node_id text,type text not null,priority text not null,state text not null,payload_json text,delivery_state text not null,delivery_attempts integer not null default 0,delivery_error text,created_at text not null,updated_at text); create table if not exists participants(agent_id text primary key, role text, joined_at text, last_seen_at text); create table if not exists subscriptions(agent_id text not null, scope_json text not null, created_at text not null);`); }
function cmdAgentNoCtx(args:string[]){ if(args[0]==='guide') return agentGuide(); throw new LoomError('LOOM_NOT_FOUND','agent command requires Loom except agent guide'); }
function cmdAgent(c:Ctx,args:string[]){ ensureRuntime(c.loom); if(args[0]==='guide') return agentGuide(); if(args[0]==='join'){ const a=args[1]; rt(c.loom,`insert or replace into participants values(${q(a)},${q(flag(args,'--role','agent')!)},${q(now())},${q(now())});`); return outData({agent_id:a, joined:true}); } if(args[0]==='default'){ const a=args[1]; ensureRegistry(); regExec(`insert or replace into registry_agent_defaults values(${q(a)},${q(c.config.id)});`); return outData({agent_id:a, default:c.config.id}); } if(args[0]==='subscribe'){ const a=args[1]; rt(c.loom,`insert into subscriptions values(${q(a)},${q(json({under:flag(args,'--under')||null, loom:c.config.id}))},${q(now())});`); return outData({agent_id:a, subscribed:true}); } throw new LoomError('INVALID_ARGUMENT','agent guide|join|default|subscribe',undefined,2); }
function agentGuideText(){ const here=dirname(fileURLToPath(import.meta.url)); const candidates=[resolve(here,'..','..','prompts','agent-guide.md'), resolve(here,'..','prompts','agent-guide.md'), resolve(process.cwd(),'docs/specs/loom-v1/agent-guide.md')]; const p=candidates.find(existsSync); return readFileSync(p || candidates[0],'utf8'); }
function agentGuide(){ out(agentGuideText()); }
function cmdInbox(c:Ctx,args:string[]){ ensureRuntime(c.loom); const sub=args[0]; if(sub==='send') return lock(c,()=>{ const agent=args[1]; const id=nextMsgId(c); const payload={message:flag(args,'--message')||'',subject:flag(args,'--subject'),sender_agent_id:process.env.LOOM_AGENT_ID,relation:'peer'}; const node=flag(args,'--node'); rt(c.loom,`insert into inbox_items values(${q(id)},${q(agent)},${q(node||'')},${q(flag(args,'--type','assignment')!)},${q(flag(args,'--priority','normal')!)},'open',${q(json(payload))},'none',0,null,${q(now())},${q(now())});`); appendEvent(c,{type:'inbox.sent',item_id:id,recipient_agent_id:agent,node_id:node}); deliver(c,id); outData({item:inboxGet(c,id)}); }); if(sub==='next'){ const agent=args[1]||process.env.LOOM_AGENT_ID; if(!agent) throw new LoomError('INVALID_ARGUMENT','agent id required',undefined,2); const rows=rtJson(c.loom,`select * from inbox_items where recipient_agent_id=${q(agent)} and state='open' order by created_at limit 1;`); return outData({item:rows[0]?inflateInbox(rows[0]):null}); } if(sub==='show'){ return outData({item:inboxGet(c,args[1])}); } if(sub==='accept'||sub==='done'||sub==='cancel'){ const id=args[1]; const st=sub==='cancel'?'cancelled':sub==='accept'?'accepted':'done'; rt(c.loom,`update inbox_items set state=${q(st)}, updated_at=${q(now())} where id=${q(id)};`); appendEvent(c,{type:'inbox.updated',item_id:id,state:st}); return outData({item:inboxGet(c,id)}); } throw new LoomError('INVALID_ARGUMENT','inbox send|next|show|accept|done',undefined,2); }
function inboxGet(c:Ctx,id:string){ const rows=rtJson(c.loom,`select * from inbox_items where id=${q(id)};`); if(!rows[0]) throw new LoomError('INBOX_ITEM_NOT_FOUND',`missing ${id}`,undefined,3); return inflateInbox(rows[0]); }
function inflateInbox(r:any){ return {...r,payload:r.payload_json?JSON.parse(r.payload_json):{}}; }
function cmdNotify(c:Ctx,args:string[]){ const agent=args[0]; const id=flag(args,'--inbox'); if(!id) throw new LoomError('INVALID_ARGUMENT','--inbox required',undefined,2); deliver(c,id,agent); outData({notified:agent,inbox:id}); }
function renderMsg(c:Ctx,item:any){ const n=item.node_id?safeRead(c,item.node_id):undefined; const p=item.payload||{}; return `New Loom item ${item.id}\n\nLoom: ${c.config.name||c.config.id} / ${c.config.id}\n${n?`Node: ${n.fm.id} ${n.fm.title}\n`:''}Type: ${item.type}\n\n${p.message||p.summary||''}\n\nInspect:\n  loom -L ${c.loom} inbox show ${item.id}\n${item.node_id?`  loom -L ${c.loom} context ${item.node_id}\n`:''}`; }
function safeRead(c:Ctx,id:string){try{return readNode(c,id)}catch{return undefined}}
function deliver(c:Ctx,id:string,agent?:string){ const item=inboxGet(c,id); const target=agent||item.recipient_agent_id; const msg=renderMsg(c,item); const res=spawnSync('tango',['message',target,msg],{encoding:'utf8'}); const ok=res.status===0; rt(c.loom,`update inbox_items set delivery_state=${q(ok?'delivered':'failed')}, delivery_attempts=delivery_attempts+1, delivery_error=${q(ok?'':(res.stderr||res.stdout||'tango message failed'))}, updated_at=${q(now())} where id=${q(id)};`); }
function routeUpdate(c:Ctx,nodeId:string,summary:string){ const subs=rtJson(c.loom,`select * from subscriptions;`); for(const s of subs){ const id=nextMsgId(c); rt(c.loom,`insert into inbox_items values(${q(id)},${q(s.agent_id)},${q(nodeId)},'subscription_event','normal','open',${q(json({summary,relation:'subscription'}))},'none',0,null,${q(now())},${q(now())});`); deliver(c,id); } }
function loomAgentPrompt(c:Ctx,agent:string,ctxPath:string,task:string){ return `You are Loom-aware. Default Loom: ${c.loom}. Context: ${ctxPath}\n\n${task}\n\n---\n\n${agentGuideText()}`; }
function loomLaunchEnv(c:Ctx,agent:string,ctxPath:string){ const bin=join(c.loom,'runtime','context',`${agent}-bin`); mkdirSync(bin,{recursive:true}); const shim=join(bin,'loom'); const cli=fileURLToPath(import.meta.url); writeFileSync(shim,`#!/usr/bin/env sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} \"$@\"\n`); chmodSync(shim,0o755); return {...process.env,PATH:`${bin}:${process.env.PATH||''}`,LOOM_HOME:process.env.LOOM_HOME||home(),LOOM_AGENT_ID:agent,LOOM_DEFAULT:c.loom,LOOM_CONTEXT:ctxPath}; }
function cmdSpawn(c:Ctx,args:string[]){ const agent=args[0]; const role=flag(args,'--role','agent'); const ctxPath=writeAgentCtx(c,agent); const prompt=loomAgentPrompt(c,agent,ctxPath,`Join Loom as ${agent}. Use Loom commands for durable updates.`); const res=spawnSync('tango',['start',agent,'--role',role!,prompt],{stdio:'inherit',env:loomLaunchEnv(c,agent,ctxPath)}); outData({agent_id:agent, status:res.status}); }
function cmdDispatch(c:Ctx,args:string[]){ const node=parseNodeRef(args[0]); const role=flag(args,'--role','worker'); const agent=`loom-${node.toLowerCase()}-${Date.now()}`; const ctxPath=writeAgentCtx(c,agent); const prompt=loomAgentPrompt(c,agent,ctxPath,`Work on ${node}. First run: loom -L ${c.loom} context ${node}`); const res=spawnSync('tango',['start',agent,'--role',role!,'--mode','oneshot',prompt],{stdio:'inherit',env:loomLaunchEnv(c,agent,ctxPath)}); outData({agent_id:agent,node,status:res.status}); }
function writeAgentCtx(c:Ctx,agent:string){ const p=join(c.loom,'runtime','context',`${agent}.json`); writeAtomic(p,json({agentId:agent,default:c.loom,looms:[{id:c.config.id,alias:c.config.name,rootPath:c.root,loomPath:c.loom}]})); return p; }

function commandSchemas(){ return [
  {name:'node.create',usage:'loom node create --title <title> [--kind kind] [--parent node] [--summary text]',mutates:true},
  {name:'node.show',usage:'loom node show <node>',mutates:false},
  {name:'node.update',usage:'loom node update <node> [--title text] [--kind kind] [--state state] [--parent node|none] [--summary text]',mutates:true},
  {name:'node.list',usage:'loom node list [--kind kind] [--state state] [--parent node|none]',mutates:false},
  {name:'edge.add',usage:'loom edge add <from> --to <to> [--type type]',mutates:true,idempotent:true},
  {name:'edge.list',usage:'loom edge list [node]',mutates:false},
  {name:'edge.types',usage:'loom edge types',mutates:false},
  {name:'note.add',usage:'loom note add <node> [message|--stdin]',mutates:true},
  {name:'note.list',usage:'loom note list <node>',mutates:false},
  {name:'note.retract',usage:'loom note retract <node:note:n> --reason <text>',mutates:true},
  {name:'context',usage:'loom context <node> [--brief]',mutates:false},
  {name:'graph.summary',usage:'loom graph summary [node|--scope node]',mutates:false},
  {name:'graph.doctor',usage:'loom graph doctor [--scope node]',mutates:false},
  {name:'patch.validate',usage:'loom patch validate --stdin [--scope node]',mutates:false},
  {name:'patch.preview',usage:'loom patch preview --stdin [--scope node]',mutates:false},
  {name:'patch.apply',usage:'loom patch apply --stdin [--scope node] [--dry-run]',mutates:true},
  {name:'draft.create',usage:'loom draft create --stdin [--scope node] [--title text]',mutates:true},
  {name:'draft.list',usage:'loom draft list',mutates:false},
  {name:'draft.show',usage:'loom draft show <draft-id>',mutates:false},
  {name:'draft.commit',usage:'loom draft commit <draft-id>',mutates:true},
  {name:'draft.discard',usage:'loom draft discard <draft-id>',mutates:true},
  {name:'lock.status',usage:'loom lock status',mutates:false},
  {name:'lock.clear-stale',usage:'loom lock clear-stale',mutates:true},
  {name:'schema.commands',usage:'loom schema commands --json',mutates:false},
  {name:'schema.command',usage:'loom schema command <name> --json',mutates:false},
]; }
function cmdSchema(args:string[]){ const schemas=commandSchemas(); if(args[0]==='commands') return outData({commands:schemas}); if(args[0]==='command'){ const name=args[1]; const command=schemas.find(s=>s.name===name); if(!command) throw new LoomError('INVALID_ARGUMENT',`unknown schema command ${name}`,undefined,2); return outData({command}); } throw new LoomError('INVALID_ARGUMENT','schema commands|command <name>',undefined,2); }
function ensureRegistry(){ mkdirSync(home(),{recursive:true}); sqlite(join(home(),'registry.sqlite'),`pragma user_version=1; create table if not exists registry_looms(id text primary key, alias text unique, title text, root_path text not null, loom_path text not null, last_seen_at text); create table if not exists registry_agent_defaults(agent_id text primary key, loom_id text not null);`); }
function cmdRegistry(args:string[]){ ensureRegistry(); if(args[0]==='list') return outData({looms:regJson('select * from registry_looms order by alias;')}); if(args[0]==='resolve') return outData({loom:regJson(`select * from registry_looms where id=${q(args[1])} or alias=${q(args[1])};`)[0]||null}); throw new LoomError('INVALID_ARGUMENT','registry list|resolve',undefined,2); }
function sqlite(db:string, sql:string){ mkdirSync(dirname(db),{recursive:true}); execFileSync('sqlite3',[db,sql],{stdio:['ignore','pipe','pipe']}); }
function dbJson(db:string, sql:string){ const s=execFileSync('sqlite3',['-json',db,sql],{encoding:'utf8'}); return s.trim()?JSON.parse(s):[]; }
function regExec(sql:string){ sqlite(join(home(),'registry.sqlite'),sql); }
function regJson(sql:string){ return dbJson(join(home(),'registry.sqlite'),sql); }
function rt(loom:string,sql:string){ ensureRuntime(loom); sqlite(join(loom,'runtime','runtime.sqlite'),sql); }
function rtJson(loom:string,sql:string){ ensureRuntime(loom); return dbJson(join(loom,'runtime','runtime.sqlite'),sql); }

main();
