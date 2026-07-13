import test from "node:test";
import assert from "node:assert/strict";
import { terminalIdentity, terminalSessionIdentity, workspaceHtml } from "../src/workspace-ui.js";

const id = "bw-0123456789abcdef01234567";
test("terminal URL accepts exactly one valid arg", () => {
  assert.equal(terminalIdentity(`/terminal/?arg=${id}`), id);
  for (const url of [
    "/terminal/?arg=secret",
    `/terminal/?arg=${id}&arg=${id}`,
    `/terminal/?arg=${id}&extra=x`,
    `/terminal/?extra=x&arg=${id}`,
    `/terminal?arg=${id}`,
    "/terminal/",
  ]) assert.equal(terminalIdentity(url), undefined, url);
});

test("terminal resource URLs inherit only the authorized session", () => {
  const cookie = `other=x; bw-terminal=${id}`;
  assert.equal(terminalSessionIdentity(`/terminal/?arg=${id}`), id);
  assert.equal(terminalSessionIdentity("/terminal/ws", cookie), id);
  assert.equal(terminalSessionIdentity("/terminal/ws?token=generated", cookie), id);
  assert.equal(terminalSessionIdentity(`/terminal/ws?arg=${id}`, cookie), id);
  assert.equal(terminalSessionIdentity("/terminal/ws?arg=secret", cookie), undefined);
  assert.equal(terminalSessionIdentity(`/terminal/ws?arg=${id}&arg=${id}`, cookie), undefined);
  assert.equal(terminalSessionIdentity("/terminal/ws", "bw-terminal=secret"), undefined);
  assert.equal(terminalSessionIdentity("/other/ws", cookie), undefined);
});

test("namespaced terminal resources remain bound to their exact workspace", () => {
  const other = "bw-abcdef0123456789abcdef01";
  const cookies = `bw-terminal-${id}=${id}; bw-terminal-${other}=${other}`;
  assert.equal(terminalIdentity(`/terminal/${id}/?arg=${id}`), id);
  assert.equal(terminalSessionIdentity(`/terminal/${id}/ws?token=x`, cookies), id);
  assert.equal(terminalSessionIdentity(`/terminal/${other}/ws?token=x`, cookies), other);
  assert.equal(terminalSessionIdentity(`/terminal/${id}/ws`, `bw-terminal-${id}=${other}`), undefined);
  assert.equal(terminalSessionIdentity(`/terminal/${id}/ws?arg=${other}`, cookies), undefined);
});

test("workspace UI retains live iframes and switches visibility without rebuilding tabs", () => {
  assert.match(workspaceHtml, /const frames=new Map\(\)/u);
  assert.match(workspaceHtml, /function select\(id\)\{state\.active=id;save\(\);showActive\(\)\}/u);
  assert.match(workspaceHtml, /open\.onclick=\(\)=>select\(tab\.id\)/u);
  assert.doesNotMatch(workspaceHtml, /open\.onclick=\(\)=>\{[^}]*render\(\)/u);
  assert.match(workspaceHtml, /f\.hidden=id!==active\?\.id/u);
  assert.match(workspaceHtml, /frames\.get\(tab\.id\)\?\.remove\(\)/u);
  assert.doesNotMatch(workspaceHtml, /main\.textContent=''/u);
});

test("workspace UI suppresses only ttyd connection overlays and bounds manual reconnect assistance", () => {
  assert.match(workspaceHtml, /CONNECTION_OVERLAYS=new Set\(\['Connection Closed','Reconnecting\.\.\.','Press ⏎ to Reconnect'\]\)/u);
  assert.match(workspaceHtml, /CONNECTION_OVERLAYS\.has\(node\.textContent\)/u);
  assert.match(workspaceHtml, /node\.style\.display='none'/u);
  assert.match(workspaceHtml, /retries<4/u);
  assert.match(workspaceHtml, /node===manual&&node\.textContent==='Press ⏎ to Reconnect'/u);
  assert.match(workspaceHtml, /f\.hidden\|\|!current\|\|!manual\.isConnected/u);
  assert.match(workspaceHtml, /new f\.contentWindow\.KeyboardEvent\('keydown',\{key:'Enter'/u);
  assert.match(workspaceHtml, /class="transport" hidden/u);
});

test("workspace UI exposes a dedicated rename control", () => {
  assert.match(workspaceHtml, /rename\.textContent='✎'/u);
  assert.match(workspaceHtml, /rename\.onclick=.*prompt\('Workspace name'/u);
  assert.doesNotMatch(workspaceHtml, /ondblclick/u);
});
