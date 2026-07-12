#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { startBridge, type BridgeIo } from './bridge.js';
import { E2bBackend } from './e2b-backend.js';
import { resolveEnvAllowlist } from './env.js';
import { FileTraceSink } from './trace.js';

const HELP = `mcp-sandbox — run any MCP server inside an isolated E2B cloud sandbox

Usage:
  mcp-sandbox run [options] -- <command...>

The server's stdio (JSON-RPC) is bridged transparently, so to your MCP client
this IS the server — but it executes in a disposable cloud sandbox with no
access to your filesystem or environment.

Options:
  --env KEY[=VALUE]   allowlist an env var for the server (repeatable);
                      bare KEY forwards the value from your local environment
  --trace <file>      record all JSON-RPC traffic as JSONL
  --ttl <seconds>     sandbox lifetime, hard session cap (default 1800)
  --template <name>   E2B sandbox template (default "base")
  --setup <command>   command to run in the sandbox before the server starts
  -h, --help          show this help

Requires E2B_API_KEY in the local environment (never forwarded).

Example — Claude Code using a sandboxed third-party server:
  claude mcp add somepkg -- npx -y mcp-sandbox run -- npx -y some-mcp-server
`;

async function main(): Promise<number> {
  const separator = process.argv.indexOf('--');
  const ownArgs = separator === -1 ? process.argv.slice(2) : process.argv.slice(2, separator);
  const serverCommand = separator === -1 ? [] : process.argv.slice(separator + 1);

  let parsed;
  try {
    parsed = parseArgs({
      args: ownArgs,
      allowPositionals: true,
      options: {
        env: { type: 'string', multiple: true, default: [] },
        trace: { type: 'string' },
        ttl: { type: 'string', default: '1800' },
        template: { type: 'string', default: 'base' },
        setup: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    process.stderr.write(`${String(error instanceof Error ? error.message : error)}\n${HELP}`);
    return 2;
  }

  if (parsed.values.help) {
    process.stderr.write(HELP);
    return 0;
  }
  if (parsed.positionals[0] !== 'run' || serverCommand.length === 0) {
    process.stderr.write(HELP);
    return 2;
  }

  const ttlSeconds = Number(parsed.values.ttl);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds < 10) {
    process.stderr.write('--ttl must be a number of seconds (>= 10)\n');
    return 2;
  }

  const apiKey = process.env.E2B_API_KEY;
  if (!apiKey) {
    process.stderr.write(
      'E2B_API_KEY is not set. Create a key at https://e2b.dev and export it locally.\n',
    );
    return 2;
  }

  let envs: Record<string, string>;
  try {
    envs = resolveEnvAllowlist(parsed.values.env, process.env);
  } catch (error) {
    process.stderr.write(`${String(error instanceof Error ? error.message : error)}\n`);
    return 2;
  }

  const log = (text: string): void => {
    process.stderr.write(`[mcp-sandbox] ${text}\n`);
  };

  const backend = new E2bBackend({
    apiKey,
    template: parsed.values.template,
    ttlSeconds,
    setupCommand: parsed.values.setup,
    log,
  });

  const io: BridgeIo = {
    onInput: (handler) => {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', handler);
    },
    onInputEnd: (handler) => {
      process.stdin.on('end', handler);
    },
    writeOut: (line) => {
      process.stdout.write(`${line}\n`);
    },
    writeErr: (text) => {
      process.stderr.write(`${text}\n`);
    },
  };

  log(`starting: ${serverCommand.join(' ')}`);
  const bridge = await startBridge({
    backend,
    io,
    command: serverCommand.map((part) => (/[\s"']/.test(part) ? JSON.stringify(part) : part)).join(' '),
    envs,
    trace: parsed.values.trace ? new FileTraceSink(parsed.values.trace) : undefined,
  });

  const shutdown = (): void => {
    log('shutting down…');
    void bridge.stop();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return bridge.done;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`[mcp-sandbox] fatal: ${String(error instanceof Error ? error.message : error)}\n`);
    process.exitCode = 1;
  },
);
