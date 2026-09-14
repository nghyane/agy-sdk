import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ProcLike, SpawnPort } from "../runtime.ts";

export interface FakeExit {
  code: number;
  signal: NodeJS.Signals | null;
}

/** ProcLike implementation backed by real streams, so readline and capture behave like production. */
export class FakeProc extends EventEmitter {
  readonly writes: string[] = [];
  killedWith: NodeJS.Signals | null = null;
  readonly stdin: Writable;
  readonly stdout: PassThrough = new PassThrough();
  readonly stderr: PassThrough = new PassThrough();
  onWrite: ((chunk: string) => void) | null = null;
  #exited = false;

  constructor() {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        const text = chunk.toString();
        this.writes.push(text);
        this.onWrite?.(text);
        callback();
      },
      final: (callback) => {
        this.exit(0);
        callback();
      },
    });
  }

  get exited(): boolean {
    return this.#exited;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killedWith = signal;
    this.emitExit(0, signal);
    return true;
  }

  reply(lines: string[]): void {
    for (const line of lines) this.stdout.write(line + "\n");
  }

  exit(code = 0): void {
    this.emitExit(code, null);
  }

  private emitExit(code: number, signal: NodeJS.Signals | null): void {
    if (this.#exited) return;
    this.#exited = true;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}

export function fakeSpawn(script: (args: string[], proc: FakeProc) => void): SpawnPort {
  return (_bin, args) => {
    const proc = new FakeProc();
    script(args, proc);
    return proc as unknown as ProcLike;
  };
}

/** NDJSON builders matching real agy stream-json output. */
export interface FixtureBuilders {
  init: (conversationId?: string, extra?: Record<string, unknown>) => string;
  text: (delta: string, conversationId?: string, state?: "ACTIVE" | "DONE") => string;
  tool: (name: string, output: string, conversationId?: string) => string;
  result: (response: string, conversationId?: string, extra?: Record<string, unknown>) => string;
}

export const fixture: FixtureBuilders = {
  init: (conversationId = "conv-1", extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ event: "init", conversation_id: conversationId, init: { cwd: "/tmp/work", tools: ["run_command"], ...extra } }),

  text: (delta: string, conversationId = "conv-1", state: "ACTIVE" | "DONE" = "ACTIVE"): string =>
    JSON.stringify({
      event: "step_update",
      step_update: { conversation_id: conversationId, step_index: 1, state, step_type: "agent_response", text_delta: delta },
    }),

  tool: (name: string, output: string, conversationId = "conv-1"): string =>
    JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: conversationId,
        step_index: 2,
        state: "DONE",
        step_type: "tool",
        tool_name: name,
        tool_info: { name, parameters: {}, output },
      },
    }),

  result: (response: string, conversationId = "conv-1", extra: Record<string, unknown> = {}): string =>
    JSON.stringify({
      event: "result",
      result: {
        conversation_id: conversationId,
        status: "SUCCESS",
        response,
        num_turns: 1,
        usage: { input_tokens: 10, output_tokens: 2, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 12 },
        ...extra,
      },
    }),
};

export function envelope(result: Record<string, unknown>): string {
  return JSON.stringify({
    conversation_id: "conv-1",
    status: "SUCCESS",
    response: "",
    duration_seconds: 0.1,
    num_turns: 1,
    ...result,
  });
}
