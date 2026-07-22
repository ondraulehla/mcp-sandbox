# mcp-sandbox

[![CI](https://github.com/ondraulehla/mcp-sandbox/actions/workflows/ci.yml/badge.svg)](https://github.com/ondraulehla/mcp-sandbox/actions/workflows/ci.yml)

Run any MCP server **inside an isolated [E2B](https://e2b.dev) cloud sandbox** instead of on your machine — one command, no code changes on either side.

```bash
npx mcp-sandbox run -- npx -y some-mcp-server-from-the-internet
```

To your MCP client (Claude Code, Claude Desktop, Cursor, …) this *is* the server: stdio JSON-RPC is bridged transparently. But the server itself executes in a disposable cloud VM with **no access to your filesystem, your environment variables, or your network identity**.

## Why

MCP servers are code you run with your agent's privileges — and most people launch them straight from a registry (`npx -y whatever-mcp`) without reading a line of it. A malicious or compromised server can read `~/.ssh`, your browser profile, and every secret in your environment. Static scanners (like [agent-audit](https://github.com/ondraulehla/agent-audit)) catch risky *configuration*; `mcp-sandbox` removes the *blast radius*: the worst a hostile server can do is trash its own disposable sandbox.

Use it for:

- **trying unknown servers** from marketplaces before you trust them
- **running servers you'll never fully trust** (scrapers, converters, community tools)
- **observing what a server actually does** (`--trace` records every JSON-RPC message)

## Quickstart

1. Get an API key at [e2b.dev](https://e2b.dev) (free tier is fine) and export it:

   ```bash
   export E2B_API_KEY=e2b_…
   ```

2. Wrap any MCP server command:

   ```bash
   npx mcp-sandbox run -- npx -y @modelcontextprotocol/server-sequential-thinking
   ```

3. Or register it with Claude Code so the sandboxing is permanent:

   ```bash
   claude mcp add seq-thinking -- npx -y mcp-sandbox run -- npx -y @modelcontextprotocol/server-sequential-thinking
   ```

The first message from your client flows the moment the sandbox is up (typically ~1–2 s).

## Cold starts: `npx`-based servers

`npx -y some-server` downloads the package on first run. If you use that as the
server command directly, the process re-execs partway through startup and the
client's first `initialize` can be lost. Pre-install it in `--setup` and run the
resulting binary instead — startup is then near-instant and stdin is stable:

```bash
npx mcp-sandbox run \
  --setup "npm install -g @modelcontextprotocol/server-everything" \
  -- mcp-server-everything
```

The client's `initialize` is buffered while `--setup` runs, so as long as your
MCP client's startup timeout covers the install (Claude Code's default is 60 s,
tunable via `MCP_TIMEOUT`), the handshake completes cleanly. `mcp-sandbox` prints
a hint if you pass an `npx`/`uvx` command without `--setup`.

## Options

| Flag | Meaning |
| --- | --- |
| `--env KEY=VALUE` | set an env var for the server (repeatable) |
| `--env KEY` | forward `KEY` from your local environment — an explicit allowlist, nothing else crosses |
| `--fs path[:to]` | copy a local file/directory into the sandbox before start (repeatable, default target `/home/user/<basename>`) |
| `--trace file.jsonl` | record all JSON-RPC traffic as JSONL (`{ts, dir, msg}` per line) |
| `--ttl seconds` | sandbox lifetime / hard session cap (default 1800) |
| `--template name` | E2B sandbox template (default `base`) |
| `--setup "cmd"` | run a command in the sandbox before the server starts (e.g. installs) |

`E2B_API_KEY` is read locally and **never forwarded** into the sandbox.

### Giving the server files: `--fs`

Some servers need data to work on (a docs folder for a search server, a CSV for
an analysis server). `--fs` copies it in explicitly:

```bash
npx mcp-sandbox run --fs ./docs -- npx -y some-docs-mcp        # → /home/user/docs
npx mcp-sandbox run --fs ./data.csv:/srv/input.csv -- …        # explicit target
```

This is **copy-in only** — the server works on its own copy, and nothing it
writes ever comes back to your machine. Symlinks are never followed (so a
mounted directory can't smuggle in `~/.ssh` through a link), and a mount is
rejected up front if it exceeds 2 000 files or 50 MB, before any sandbox is
created. Files land before `--setup` runs, so setup can use them
(e.g. `--setup "pip install -r /home/user/project/requirements.txt"`).

## Security model

- The server process runs in an E2B micro-VM: your files, your env and your local network are unreachable. The sandbox has its own internet access (that's usually what the server needs to be useful) — it acts from a cloud IP, not as you.
- Environment crossing is **allowlist-only** (`--env`), the exact inverse of the usual "inherit everything" default.
- The only channel between your machine and the server is the MCP protocol stream itself — and `--trace` lets you keep a verbatim record of it. Prompt-injection attempts *through* tool results still reach your client (sandboxing can't fix that layer); what it removes is arbitrary code execution against your machine.
- Sandboxes die at `--ttl` no matter what.

## How it works

```
MCP client ──stdio──▶ mcp-sandbox ──E2B API──▶ [sandbox: npx some-mcp-server]
              JSON-RPC     │  line-buffered bridge
                           └──▶ trace.jsonl (optional)
```

`mcp-sandbox` spawns one E2B sandbox per session, starts the server there with `stdin: true`, and pipes bytes both ways. Server output is line-buffered so your client never sees a partial JSON-RPC frame even when the transport chunks arbitrarily; server stderr is forwarded to your stderr with a `[sandbox]` prefix, never into the protocol stream.

## Development

```bash
npm install
npm test        # 23 tests — bridge + --fs logic run offline, no E2B needed
npm run build
```

The E2B integration lives behind a small `SandboxBackend` interface (`src/types.ts`), which is what makes the bridge fully testable offline.

## Roadmap

- Trace viewer integration with [agent-lens](https://github.com/ondraulehla/agent-lens)
- Sandbox pooling for faster cold starts
- HTTP/SSE transport bridging for remote-style servers

## License

MIT © Ondřej Úlehla
