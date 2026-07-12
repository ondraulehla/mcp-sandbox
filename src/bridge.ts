import { LineBuffer } from './line-buffer.js';
import type { SandboxBackend, SandboxProcess, TraceSink } from './types.js';

export interface BridgeIo {
  /** Local stdin chunks arrive here (wired to process.stdin by the CLI). */
  onInput(handler: (chunk: string) => void): void;
  /** Called when local stdin closes (client hung up). */
  onInputEnd(handler: () => void): void;
  /** Write a complete protocol line to the local client (stdout). */
  writeOut(line: string): void;
  /** Diagnostics channel (stderr) — never mixes with the protocol stream. */
  writeErr(text: string): void;
}

export interface BridgeOpts {
  backend: SandboxBackend;
  io: BridgeIo;
  command: string;
  envs: Record<string, string>;
  trace?: TraceSink | undefined;
  /** Prefix for forwarded server stderr lines. */
  stderrPrefix?: string;
}

export interface BridgeResult {
  /** Resolves with the server's exit code once either side terminates. */
  done: Promise<number>;
  stop(): Promise<void>;
}

/**
 * Transparent stdio bridge between a local MCP client and a server process
 * running inside the sandbox. Bytes from the client are forwarded verbatim;
 * server output is line-buffered so the client never sees a partial JSON-RPC
 * message even when the transport chunks arbitrarily.
 */
export async function startBridge(opts: BridgeOpts): Promise<BridgeResult> {
  const { backend, io, trace } = opts;
  const prefix = opts.stderrPrefix ?? '[sandbox] ';
  const outBuffer = new LineBuffer();
  const errBuffer = new LineBuffer();

  let resolveDone: (code: number) => void;
  const done = new Promise<number>((resolve) => {
    resolveDone = resolve;
  });
  let finished = false;
  const finish = async (code: number): Promise<void> => {
    if (finished) return;
    finished = true;
    const rest = outBuffer.flush();
    if (rest) {
      trace?.record('server->client', rest);
      io.writeOut(rest);
    }
    await trace?.close();
    await backend.close();
    resolveDone(code);
  };

  const proc: SandboxProcess = await backend.start({
    command: opts.command,
    envs: opts.envs,
    onStdout: (chunk) => {
      for (const line of outBuffer.push(chunk)) {
        trace?.record('server->client', line);
        io.writeOut(line);
      }
    },
    onStderr: (chunk) => {
      for (const line of errBuffer.push(chunk)) io.writeErr(`${prefix}${line}`);
    },
    onExit: (code) => {
      void finish(code ?? 0);
    },
  });

  const inBuffer = new LineBuffer();
  io.onInput((chunk) => {
    // trace per complete line, but forward the raw bytes untouched
    for (const line of inBuffer.push(chunk)) trace?.record('client->server', line);
    void proc.sendStdin(chunk).catch((error: unknown) => {
      io.writeErr(`${prefix}stdin forwarding failed: ${String(error)}`);
      void stop();
    });
  });
  io.onInputEnd(() => {
    // client hung up → the session is over
    void stop();
  });

  const stop = async (): Promise<void> => {
    try {
      await proc.kill();
    } catch {
      // sandbox may already be gone
    }
    await finish(0);
  };

  return { done, stop };
}
