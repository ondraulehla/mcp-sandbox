import { describe, expect, it } from 'vitest';
import { startBridge, type BridgeIo } from '../src/bridge.js';
import { LineBuffer } from '../src/line-buffer.js';
import { resolveEnvAllowlist } from '../src/env.js';
import type { SandboxBackend, SandboxProcessOpts, TraceSink } from '../src/types.js';

/** In-memory sandbox fake: exposes the wired callbacks for the test to drive. */
function fakeBackend() {
  const state = {
    opts: undefined as SandboxProcessOpts | undefined,
    stdin: [] as string[],
    killed: false,
    closed: false,
  };
  const backend: SandboxBackend = {
    describe: () => 'fake',
    start(opts) {
      state.opts = opts;
      return Promise.resolve({
        sendStdin(data: string) {
          state.stdin.push(data);
          return Promise.resolve();
        },
        kill() {
          state.killed = true;
          return Promise.resolve();
        },
      });
    },
    close() {
      state.closed = true;
      return Promise.resolve();
    },
  };
  return { backend, state };
}

function fakeIo() {
  const out: string[] = [];
  const err: string[] = [];
  let input: ((chunk: string) => void) | undefined;
  let inputEnd: (() => void) | undefined;
  const io: BridgeIo = {
    onInput: (h) => (input = h),
    onInputEnd: (h) => (inputEnd = h),
    writeOut: (line) => out.push(line),
    writeErr: (text) => err.push(text),
  };
  return { io, out, err, feed: (c: string) => input?.(c), hangup: () => inputEnd?.() };
}

function memoryTrace() {
  const records: { dir: string; line: string }[] = [];
  const sink: TraceSink = {
    record: (dir, line) => records.push({ dir, line }),
    close: () => Promise.resolve(),
  };
  return { sink, records };
}

const REQ = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
const RES = '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}';

describe('LineBuffer', () => {
  it('reassembles arbitrarily chunked lines', () => {
    const buffer = new LineBuffer();
    expect(buffer.push('{"a"')).toEqual([]);
    expect(buffer.push(':1}\n{"b":')).toEqual(['{"a":1}']);
    expect(buffer.push('2}\n')).toEqual(['{"b":2}']);
    expect(buffer.flush()).toBeNull();
  });

  it('handles multiple lines in one chunk and skips empties', () => {
    const buffer = new LineBuffer();
    expect(buffer.push('one\n\ntwo\nthree')).toEqual(['one', 'two']);
    expect(buffer.flush()).toBe('three');
  });
});

describe('resolveEnvAllowlist', () => {
  it('accepts KEY=value and forwards bare KEY from local env', () => {
    const envs = resolveEnvAllowlist(['FOO=bar', 'HOME'], { HOME: '/home/u' });
    expect(envs).toEqual({ FOO: 'bar', HOME: '/home/u' });
  });

  it('rejects bare KEY missing locally', () => {
    expect(() => resolveEnvAllowlist(['NOPE'], {})).toThrow(/not set/);
  });

  it('keeps = inside values intact', () => {
    expect(resolveEnvAllowlist(['URL=postgres://u:p@h/db?a=b'], {})).toEqual({
      URL: 'postgres://u:p@h/db?a=b',
    });
  });
});

describe('startBridge', () => {
  it('forwards client bytes verbatim and line-buffers server output', async () => {
    const { backend, state } = fakeBackend();
    const { io, out, feed } = fakeIo();
    await startBridge({ backend, io, command: 'server', envs: {} });

    feed(`${REQ}\n`);
    expect(state.stdin).toEqual([`${REQ}\n`]);

    // server responds in awkward chunks
    state.opts!.onStdout(RES.slice(0, 10));
    expect(out).toEqual([]);
    state.opts!.onStdout(`${RES.slice(10)}\n`);
    expect(out).toEqual([RES]);
  });

  it('traces both directions as complete lines', async () => {
    const { backend, state } = fakeBackend();
    const { io, feed } = fakeIo();
    const { sink, records } = memoryTrace();
    await startBridge({ backend, io, command: 'server', envs: {}, trace: sink });

    feed(`${REQ}\n`);
    state.opts!.onStdout(`${RES}\n`);

    expect(records).toEqual([
      { dir: 'client->server', line: REQ },
      { dir: 'server->client', line: RES },
    ]);
  });

  it('routes server stderr to diagnostics with a prefix, never to stdout', async () => {
    const { backend, state } = fakeBackend();
    const { io, out, err } = fakeIo();
    await startBridge({ backend, io, command: 'server', envs: {} });

    state.opts!.onStderr('warming up\n');
    expect(out).toEqual([]);
    expect(err).toEqual(['[sandbox] warming up']);
  });

  it('resolves done with the server exit code and closes the backend', async () => {
    const { backend, state } = fakeBackend();
    const { io } = fakeIo();
    const bridge = await startBridge({ backend, io, command: 'server', envs: {} });

    state.opts!.onExit(3);
    await expect(bridge.done).resolves.toBe(3);
    expect(state.closed).toBe(true);
  });

  it('kills the server when the client hangs up', async () => {
    const { backend, state } = fakeBackend();
    const { io, hangup } = fakeIo();
    const bridge = await startBridge({ backend, io, command: 'server', envs: {} });

    hangup();
    await bridge.done;
    expect(state.killed).toBe(true);
    expect(state.closed).toBe(true);
  });

  it('flushes an unterminated trailing server line on shutdown', async () => {
    const { backend, state } = fakeBackend();
    const { io, out } = fakeIo();
    const bridge = await startBridge({ backend, io, command: 'server', envs: {} });

    state.opts!.onStdout('{"partial":true}'); // no newline
    state.opts!.onExit(0);
    await bridge.done;
    expect(out).toEqual(['{"partial":true}']);
  });
});
