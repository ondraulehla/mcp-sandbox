/**
 * Reassembles arbitrarily chunked stream data into complete lines.
 * MCP stdio framing is newline-delimited JSON-RPC, but transports deliver
 * chunks split at arbitrary byte boundaries — never forward a partial line.
 */
export class LineBuffer {
  private pending = '';

  /** Feed a chunk; returns every *complete* line it unlocked (without newlines). */
  push(chunk: string): string[] {
    this.pending += chunk;
    const parts = this.pending.split('\n');
    this.pending = parts.pop() ?? '';
    return parts.filter((line) => line.length > 0);
  }

  /** Whatever is left unterminated (used on shutdown). */
  flush(): string | null {
    const rest = this.pending;
    this.pending = '';
    return rest.length > 0 ? rest : null;
  }
}
