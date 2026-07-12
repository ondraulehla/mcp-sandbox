#!/usr/bin/env node
/**
 * Live smoke test against a real E2B sandbox. Drives mcp-sandbox as an MCP
 * client would: initialize → initialized → tools/list, then reports the
 * server name and tool count. Requires E2B_API_KEY.
 *
 * Usage:
 *   node scripts/smoke.mjs [--setup "install cmd"] -- <server command...>
 *
 * Example (pre-installs so startup is fast and stdin is stable):
 *   node scripts/smoke.mjs \
 *     --setup "npm install -g @modelcontextprotocol/server-everything" \
 *     -- mcp-server-everything
 */
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep === -1 || sep === argv.length - 1) {
  console.error('usage: node scripts/smoke.mjs [--setup "cmd"] -- <server command...>');
  process.exit(2);
}
const own = argv.slice(0, sep);
const server = argv.slice(sep + 1);
const setupIdx = own.indexOf('--setup');
const setup = setupIdx !== -1 ? own[setupIdx + 1] : undefined;

const cliArgs = ['dist/cli.js', 'run', '--trace', '/tmp/mcp-trace.jsonl'];
if (setup) cliArgs.push('--setup', setup);
cliArgs.push('--', ...server);

const child = spawn('node', cliArgs, { stdio: ['pipe', 'pipe', 'inherit'] });
const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } },
});

let buffer = '';
let initialized = false;
const deadline = setTimeout(() => {
  console.error('\n✗ timed out waiting for tools/list');
  child.kill();
  process.exit(1);
}, 150_000);

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === 1 && msg.result && !initialized) {
      initialized = true;
      console.error(`\n✓ initialize → ${msg.result.serverInfo?.name} ${msg.result.serverInfo?.version ?? ''}`);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    } else if (msg.id === 2 && msg.result) {
      const names = (msg.result.tools ?? []).map((t) => t.name);
      console.error(`✓ tools/list → ${names.length} tools: ${names.slice(0, 6).join(', ')}${names.length > 6 ? ', …' : ''}`);
      console.error('✓ trace written to /tmp/mcp-trace.jsonl');
      clearTimeout(deadline);
      child.stdin.end();
      child.kill();
      process.exit(0);
    }
  }
});

child.on('exit', (code) => {
  clearTimeout(deadline);
  if (!initialized) {
    console.error(`\n✗ bridge exited (code ${code}) before initialize completed`);
    process.exit(1);
  }
});
