#!/usr/bin/env node
import fs from 'node:fs';

const logPath = process.env.MCP_HANDTEST_LOG || '/tmp/async-claude-mcp-handtest/server.log';
const sendMode = process.env.MCP_SEND_MODE || 'line'; // Claude Code 2.1.197 used newline-delimited JSON-RPC in local tests.
fs.mkdirSync(logPath.split('/').slice(0, -1).join('/') || '.', { recursive: true });

function log(event) {
  fs.appendFileSync(logPath, JSON.stringify({ t: new Date().toISOString(), ...event }) + '\n');
}

function send(obj) {
  const payload = JSON.stringify(obj);
  if (sendMode === 'header') {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
  } else {
    process.stdout.write(payload + '\n');
  }
  log({ event: 'send', mode: sendMode, obj });
}

function toolListResult() {
  return {
    tools: [
      {
        name: 'sentinel',
        description: 'Return exact MCP sentinel string.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
  };
}

function handle(msg) {
  log({ event: 'recv-json', msg });
  if (msg?.id === undefined) return;
  switch (msg.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion || '2025-11-25',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'handtest', version: '0.0.1' },
        },
      });
      break;
    case 'tools/list':
      send({ jsonrpc: '2.0', id: msg.id, result: toolListResult() });
      break;
    case 'tools/call':
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: 'MCP_SENTINEL_OK' }], isError: false },
      });
      break;
    default:
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
}

let headerBuf = Buffer.alloc(0);
let lineBuf = '';

function pumpHeaders() {
  while (true) {
    const idx = headerBuf.indexOf(Buffer.from('\r\n\r\n'));
    if (idx < 0) return;
    const head = headerBuf.subarray(0, idx).toString('utf8');
    const match = /Content-Length:\s*(\d+)/i.exec(head);
    if (!match) {
      log({ event: 'bad-header', head });
      return;
    }
    const len = Number(match[1]);
    const start = idx + 4;
    if (headerBuf.length - start < len) return;
    const body = headerBuf.subarray(start, start + len).toString('utf8');
    headerBuf = headerBuf.subarray(start + len);
    try { handle(JSON.parse(body)); } catch (error) { log({ event: 'parse-error-header', error: String(error), body }); }
  }
}

function pumpLines(data) {
  lineBuf += data.toString('utf8');
  while (true) {
    const idx = lineBuf.indexOf('\n');
    if (idx < 0) return;
    const line = lineBuf.slice(0, idx).trim();
    lineBuf = lineBuf.slice(idx + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch (error) { log({ event: 'parse-error-line', error: String(error), line }); }
  }
}

log({ event: 'start', argv: process.argv.slice(2), cwd: process.cwd(), env: { HOME: process.env.HOME, MCP_SEND_MODE: sendMode } });

process.stdin.on('data', (chunk) => {
  log({ event: 'raw', text: chunk.toString('utf8').slice(0, 1000), hex: chunk.toString('hex').slice(0, 500) });
  headerBuf = Buffer.concat([headerBuf, chunk]);
  pumpHeaders();
  pumpLines(chunk);
});
process.stdin.on('end', () => log({ event: 'end', remainingHeader: headerBuf.toString('utf8'), remainingLine: lineBuf }));
setInterval(() => {}, 1000);
