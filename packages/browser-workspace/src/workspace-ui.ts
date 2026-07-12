import http from "node:http";
import net from "node:net";
import { URL } from "node:url";
import type { BrowserWorkspaceConfigV1 as C } from "./contracts.js";
import { execBounded } from "./process.js";
import { defaultDropRoot, receiveUpload, UploadError } from "./upload.js";

const ID = /^bw-[a-f0-9]{24}$/u;
const TERMINAL_COOKIE = "bw-terminal";
const terminalPrefix = (id: string) => `/terminal/${id}`;
export function terminalIdentity(rawUrl: string): string | undefined {
  let url: URL; try { url = new URL(rawUrl, "http://localhost"); } catch { return; }
  const entries = [...url.searchParams.entries()];
  if (entries.length !== 1 || entries[0][0] !== "arg" || !ID.test(entries[0][1])) return;
  const id = entries[0][1];
  if (url.pathname !== "/terminal/" && url.pathname !== `${terminalPrefix(id)}/`) return;
  return id;
}
export function terminalSessionIdentity(rawUrl: string, cookie?: string): string | undefined {
  let url: URL; try { url = new URL(rawUrl, "http://localhost"); } catch { return; }
  if (!url.pathname.startsWith("/terminal/")) return;
  const initial = terminalIdentity(rawUrl);
  if (initial) return initial;
  const namespaced = url.pathname.match(/^\/terminal\/(bw-[a-f0-9]{24})(?:\/|$)/u)?.[1];
  const cookieName = namespaced ? `${TERMINAL_COOKIE}-${namespaced}` : TERMINAL_COOKIE;
  const id = cookie?.split(";").map(value => value.trim().split("=")).find(([name]) => name === cookieName)?.[1];
  if (!id || !ID.test(id) || (namespaced && id !== namespaced)) return;
  const args = url.searchParams.getAll("arg");
  if (args.length && (args.length !== 1 || args[0] !== id)) return;
  return id;
}
export const workspaceHtml = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,height=device-height"><title>Browser workspaces</title><style>
*{box-sizing:border-box}html,body{margin:0;height:100%;background:#111;color:#ddd;font:14px system-ui}body{display:flex}aside{width:190px;padding:10px;background:#1c1c1c;display:flex;flex-direction:column;gap:8px}h1{font-size:13px;margin:2px 0 8px;color:#aaa}.tabs{display:flex;flex-direction:column;gap:5px;overflow:auto}.tab{display:flex;gap:4px}.tab button:first-child{flex:1;text-align:left}.active button:first-child{background:#555}button{border:0;border-radius:4px;padding:7px;background:#333;color:#eee;cursor:pointer}.uploads{margin-top:auto;border:1px dashed #555;border-radius:5px;padding:7px;min-height:42px;color:#aaa;font-size:12px}.uploads.drag{border-color:#aaa;background:#292929}.upload-title{text-align:center}.recent{margin-top:5px;display:flex;flex-direction:column;gap:3px}.upload-row{display:flex;align-items:center;gap:3px;min-width:0}.upload-name{direction:rtl;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;color:#ddd}.copy{padding:3px 5px;font-size:11px}.error{color:#d88}.new{margin-top:0}main{flex:1;position:relative}iframe{position:absolute;inset:0;border:0;width:100%;height:100%}.empty{padding:30px;color:#aaa}.dead button:first-child{text-decoration:line-through;color:#aaa}
</style></head><body><aside><h1>WORKSPACES</h1><div class="tabs"></div><div class="uploads"><div class="upload-title">Drop files here</div><div class="recent"></div></div><button class="new">+ New workspace</button></aside><main></main><script>
const KEY='bravo-browser-workspaces-v1',UPLOAD_KEY='bravo-browser-uploads-v1';let state;try{state=JSON.parse(localStorage.getItem(KEY))}catch{}if(!state||!Array.isArray(state.tabs))state={tabs:[],active:null};let uploads=[];try{uploads=JSON.parse(localStorage.getItem(UPLOAD_KEY))}catch{}if(!Array.isArray(uploads))uploads=[];uploads=uploads.slice(0,3);
const save=()=>localStorage.setItem(KEY,JSON.stringify(state));const api=async(path,body)=>{const r=await fetch(path,{method:body?'POST':'GET',headers:{'content-type':'application/json'},body:body&&JSON.stringify(body)});return {ok:r.ok,data:await r.json()}};const frames=new Map();const empty=document.createElement('div');empty.className='empty';document.querySelector('main').append(empty);
function showActive(){const active=state.tabs.find(x=>x.id===state.active);for(const row of document.querySelectorAll('.tab'))row.classList.toggle('active',row.dataset.id===active?.id);for(const [id,f] of frames)f.hidden=id!==active?.id;empty.hidden=!!active?.live;empty.textContent=active?'This tmux session is no longer live. Forget the tab or create another workspace.':'Create a workspace to begin.'}function select(id){state.active=id;save();showActive()}
async function render(){const box=document.querySelector('.tabs'),main=document.querySelector('main');box.textContent='';for(const tab of state.tabs){const status=await api('/api/session/'+tab.id);tab.live=status.ok&&status.data.live;if(tab.live&&!frames.has(tab.id)){const f=document.createElement('iframe');f.src='/terminal/'+encodeURIComponent(tab.id)+'/?arg='+encodeURIComponent(tab.id);frames.set(tab.id,f);main.append(f)}if(!tab.live&&frames.has(tab.id)){frames.get(tab.id).remove();frames.delete(tab.id)}const row=document.createElement('div');row.dataset.id=tab.id;row.className='tab '+(tab.live?'':'dead');const open=document.createElement('button');open.textContent=tab.name+(tab.live?'':' (stale)');open.onclick=()=>select(tab.id);const rename=document.createElement('button');rename.textContent='✎';rename.title='Rename';rename.onclick=()=>{const n=prompt('Workspace name',tab.name);if(n&&n.trim()){tab.name=n.trim();save();render()}};const forget=document.createElement('button');forget.textContent='×';forget.title='Forget (does not kill tmux)';forget.onclick=()=>{if(confirm('Forget this tab? Its tmux session will keep running.')){frames.get(tab.id)?.remove();frames.delete(tab.id);state.tabs=state.tabs.filter(x=>x!==tab);if(state.active===tab.id)state.active=state.tabs[0]?.id??null;save();render()}};row.append(open,rename,forget);box.append(row)}for(const [id,f] of frames)if(!state.tabs.some(tab=>tab.id===id)){f.remove();frames.delete(id)}showActive()}
const zone=document.querySelector('.uploads'),recent=document.querySelector('.recent');function renderUploads(){recent.textContent='';for(const item of uploads){const row=document.createElement('div');row.className='upload-row';const name=document.createElement('span');name.className='upload-name';name.textContent=item.name;name.title=item.path;const copy=document.createElement('button');copy.className='copy';copy.textContent='copy';copy.title='Copy full path';copy.onclick=async()=>{await navigator.clipboard.writeText(item.path);copy.textContent='copied';setTimeout(()=>copy.textContent='copy',800)};row.append(name,copy);recent.append(row)}}for(const event of ['dragenter','dragover'])zone.addEventListener(event,e=>{e.preventDefault();zone.classList.add('drag')});for(const event of ['dragleave','drop'])zone.addEventListener(event,()=>zone.classList.remove('drag'));zone.addEventListener('drop',async e=>{e.preventDefault();for(const file of [...e.dataTransfer.files].filter(file=>file.size>0)){document.querySelector('.upload-title').textContent='Uploading…';try{const r=await fetch('/api/upload',{method:'POST',headers:{'content-type':file.type||'application/octet-stream','x-file-name':encodeURIComponent(file.name)},body:file});const data=await r.json();if(!r.ok)throw new Error(data.error||'Upload failed');uploads=[{name:data.name,path:data.path,size:data.size,uploadedAt:new Date().toISOString()},...uploads].slice(0,3);localStorage.setItem(UPLOAD_KEY,JSON.stringify(uploads));renderUploads()}catch(error){document.querySelector('.upload-title').textContent=error.message;zone.classList.add('error');continue}document.querySelector('.upload-title').textContent='Drop files here';zone.classList.remove('error')}});document.querySelector('.new').onclick=async()=>{const id='bw-'+[...crypto.getRandomValues(new Uint8Array(12))].map(x=>x.toString(16).padStart(2,'0')).join('');const name=prompt('Workspace name','Workspace '+(state.tabs.length+1));if(!name)return;const r=await api('/api/session',{id});if(!r.ok)return alert(r.data.error||'Could not create workspace');state.tabs.push({id,name:name.trim()||'Workspace'});state.active=id;save();render()};renderUploads();render();
</script></body></html>`;

export class WorkspaceUiServer {
  private server?: http.Server;
  constructor(readonly config: C, readonly ttydPort: number, readonly dropRoot = defaultDropRoot()) {}
  private tmux(...args: string[]) { return execBounded({ executable: this.config.executables.tmux, args: ["-L", this.config.tmuxSocketName, ...args] }, 5000); }
  private async live(id: string) { if (!ID.test(id)) return false; return (await this.tmux("has-session", "-t", `=${id}`)).code === 0; }
  async start(): Promise<void> {
    this.server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (req.method === "GET" && url.pathname === "/") return void res.end(workspaceHtml);
        if (req.method === "GET" && url.pathname.startsWith("/api/session/")) return this.json(res, 200, { live: await this.live(url.pathname.slice(13)) });
        if (req.method === "POST" && url.pathname === "/api/upload") {
          return this.json(res, 201, await receiveUpload(req, this.dropRoot));
        }
        if (req.method === "POST" && url.pathname === "/api/session") {
          const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const id = JSON.parse(Buffer.concat(chunks).toString()).id;
          if (!ID.test(id)) return this.json(res, 400, { error: "invalid identity" });
          if (await this.live(id)) return this.json(res, 409, { error: "identity already exists" });
          const made = await this.tmux("new-session", "-d", "-s", id, "-c", this.config.workspace);
          return this.json(res, made.code === 0 ? 201 : 500, made.code === 0 ? { created: true } : { error: "tmux could not create session" });
        }
        if (url.pathname.startsWith("/terminal/")) {
          const initial = terminalIdentity(req.url ?? "");
          const id = terminalSessionIdentity(req.url ?? "", req.headers.cookie);
          if (req.method !== "GET" || !id || !await this.live(id)) return this.json(res, 404, { error: "terminal session not found" });
          return this.proxy(req, res, initial);
        }
        this.json(res, 404, { error: "not found" });
      } catch (error) { const status = error instanceof UploadError ? error.statusCode : 400; this.json(res, status, { error: error instanceof UploadError ? error.message : "bad request" }); }
    });
    this.server.on("upgrade", async (req, socket, head) => {
      try {
        const id = terminalSessionIdentity(req.url ?? "", req.headers.cookie);
        if (!id || !await this.live(id)) return socket.destroy();
        const upstream = net.connect(this.ttydPort, "127.0.0.1", () => { upstream.write(this.requestHead(req)); if (head.length) upstream.write(head); socket.pipe(upstream).pipe(socket); }); upstream.on("error", () => socket.destroy());
      } catch { socket.destroy(); }
    });
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(this.config.listenPort, "127.0.0.1", resolve); });
  }
  private upstreamHeaders(req: http.IncomingMessage) { return { ...req.headers, host: `127.0.0.1:${this.ttydPort}`, ...(req.headers.origin ? { origin: `http://127.0.0.1:${this.ttydPort}` } : {}) }; }
  private upstreamPath(rawUrl: string) { const url = new URL(rawUrl, "http://localhost"); const match = url.pathname.match(/^\/terminal\/(bw-[a-f0-9]{24})(\/.*|$)/u); url.pathname = match ? match[2] || "/" : url.pathname.slice("/terminal".length) || "/"; return `${url.pathname}${url.search}`; }
  private proxy(req: http.IncomingMessage, res: http.ServerResponse, initial?: string) { const out = http.request({ hostname: "127.0.0.1", port: this.ttydPort, method: req.method, path: this.upstreamPath(req.url!), headers: this.upstreamHeaders(req) }, r => { const namespaced = initial && new URL(req.url!, "http://localhost").pathname.startsWith(`${terminalPrefix(initial)}/`); const headers = { ...r.headers, ...(initial ? { "set-cookie": `${TERMINAL_COOKIE}${namespaced?`-${initial}`:""}=${initial}; Path=${namespaced?`${terminalPrefix(initial)}/`:"/terminal/"}; HttpOnly; SameSite=Strict` } : {}) }; res.writeHead(r.statusCode ?? 502, headers); r.pipe(res); }); out.on("error", () => { res.statusCode=502;res.end(); }); req.pipe(out); }
  private requestHead(req: http.IncomingMessage) { const path = this.upstreamPath(req.url!); const headers = this.upstreamHeaders(req); return `${req.method} ${path} HTTP/${req.httpVersion}\r\n${Object.entries(headers).map(([k,v])=>`${k}: ${Array.isArray(v)?v.join(", "):v}`).join("\r\n")}\r\n\r\n`; }
  private json(res: http.ServerResponse, code: number, value: unknown) { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(value)); }
  async stop() { if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve())); }
}
