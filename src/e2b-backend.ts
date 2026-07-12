import { Sandbox } from 'e2b';
import type { SandboxBackend, SandboxProcess, SandboxProcessOpts } from './types.js';

export interface E2bBackendOpts {
  apiKey: string;
  /** Sandbox template name. */
  template: string;
  /** Sandbox lifetime in seconds — the hard cap for the MCP session. */
  ttlSeconds: number;
  /** Optional command to run before the server starts (e.g. installs). */
  setupCommand?: string | undefined;
  /** Diagnostics writer (stderr). */
  log: (text: string) => void;
}

/** Real E2B adapter: one sandbox per bridged MCP server session. */
export class E2bBackend implements SandboxBackend {
  private sandbox: Sandbox | null = null;

  constructor(private readonly opts: E2bBackendOpts) {}

  describe(): string {
    return this.sandbox ? `e2b sandbox ${this.sandbox.sandboxId}` : 'e2b sandbox (not started)';
  }

  async start(processOpts: SandboxProcessOpts): Promise<SandboxProcess> {
    const { opts } = this;
    this.sandbox = await Sandbox.create(opts.template, {
      apiKey: opts.apiKey,
      timeoutMs: opts.ttlSeconds * 1000,
    });
    opts.log(`sandbox ${this.sandbox.sandboxId} up (template ${opts.template}, ttl ${opts.ttlSeconds}s)`);

    if (opts.setupCommand) {
      opts.log(`running setup: ${opts.setupCommand}`);
      const setup = await this.sandbox.commands.run(opts.setupCommand, {
        timeoutMs: 0,
        onStderr: (chunk: string) => opts.log(chunk.trimEnd()),
      });
      if (setup.exitCode !== 0) {
        throw new Error(`setup command failed with exit code ${setup.exitCode}`);
      }
    }

    const handle = await this.sandbox.commands.run(processOpts.command, {
      background: true,
      stdin: true,
      timeoutMs: 0, // the sandbox TTL is the only limit for a long-lived server
      envs: processOpts.envs,
      onStdout: processOpts.onStdout,
      onStderr: processOpts.onStderr,
    });

    void handle
      .wait()
      .then((result) => processOpts.onExit(result.exitCode))
      .catch(() => processOpts.onExit(null));

    return {
      sendStdin: async (data) => {
        await handle.sendStdin(data);
      },
      kill: async () => {
        await handle.kill();
      },
    };
  }

  async close(): Promise<void> {
    const sandbox = this.sandbox;
    this.sandbox = null;
    if (sandbox) {
      try {
        await sandbox.kill();
      } catch {
        // TTL will reap it anyway
      }
    }
  }
}
