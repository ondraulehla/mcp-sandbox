/**
 * The sandbox layer is injected so the bridge is fully testable without E2B —
 * tests use an in-memory fake, the CLI wires the real E2B backend.
 */

export interface SandboxProcessOpts {
  /** Full command line to run inside the sandbox. */
  command: string;
  /** Environment variables to set for the process (the allowlisted set). */
  envs: Record<string, string>;
  onStdout: (chunk: string) => void;
  onStderr: (chunk: string) => void;
  onExit: (code: number | null) => void;
}

export interface SandboxProcess {
  sendStdin(data: string): Promise<void>;
  kill(): Promise<void>;
}

export interface SandboxBackend {
  /** Human-readable identifier shown in diagnostics (e.g. sandbox id). */
  describe(): string;
  start(opts: SandboxProcessOpts): Promise<SandboxProcess>;
  /** Tear the sandbox down (idempotent). */
  close(): Promise<void>;
}

export interface TraceSink {
  record(direction: 'client->server' | 'server->client', line: string): void;
  close(): Promise<void>;
}
