import { createWriteStream, type WriteStream } from 'node:fs';
import type { TraceSink } from './types.js';

/**
 * Records bridged JSON-RPC traffic as JSONL — one object per protocol line:
 * { ts, dir, msg } with msg parsed when possible (raw string otherwise).
 * The format is intentionally agent-lens-friendly.
 */
export class FileTraceSink implements TraceSink {
  private stream: WriteStream;

  constructor(path: string) {
    this.stream = createWriteStream(path, { flags: 'a' });
  }

  record(direction: 'client->server' | 'server->client', line: string): void {
    let msg: unknown = line;
    try {
      msg = JSON.parse(line);
    } catch {
      // keep raw — a hostile or broken server must not break tracing
    }
    this.stream.write(
      `${JSON.stringify({ ts: new Date().toISOString(), dir: direction, msg })}\n`,
    );
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.stream.end(() => resolve()));
  }
}
