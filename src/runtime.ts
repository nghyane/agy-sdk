import { spawn as nodeSpawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { AgyError, classifyError, type AgyErrorKind } from "./errors.ts";
import { extractEnvelope, extractStructured, parseEvent } from "./protocol/parse.ts";
import type { AgyEvent, RunResult } from "./protocol/types.ts";
import { formatDuration, parseUsage, type QuotaPools } from "./quota.ts";

export type Effort = "low" | "medium" | "high";

/** Minimal surface of a spawned process. Injected so tests run without the real agy binary. */
export interface ProcLike {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  on(event: string, listener: (...args: any[]) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnPort = (
  bin: string,
  args: string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv },
) => ProcLike;

export const defaultSpawn: SpawnPort = (bin, args, opts) =>
  nodeSpawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] }) as unknown as ProcLike;

export interface RuntimeOptions {
  /** Binary name or path. Default: "agy". */
  bin?: string;
  /** HOME for the spawned process — this is how accounts/workspaces are isolated. Default: inherited. */
  home?: string;
  cwd?: string;
  model?: string;
  effort?: Effort;
  /** Extra args appended to every agy invocation. */
  extraArgs?: string[];
  env?: Record<string, string | undefined>;
  spawn?: SpawnPort;
  /** Default timeout for runs and turns. Default: 300000 (agy's own default). */
  defaultTimeoutMs?: number;
  onWarning?: (message: string) => void;
}

export interface RunOptions {
  schema?: unknown;
  model?: string;
  effort?: Effort;
  timeoutMs?: number;
  /** Resume a conversation by id (`--conversation`). */
  resume?: string;
  /** Resume the most recent conversation (`--continue`). */
  continueLatest?: boolean;
  signal?: AbortSignal;
}

export interface StepOptions<T> extends RunOptions {
  prompt: string;
  /** Convert the run result to the expected value. Default: `structured_output` or JSON in `response`. */
  parse?: (result: RunResult) => T;
  /** Return a problem description to re-run with feedback, or null when valid. */
  validate?: (value: T) => string | null | Promise<string | null>;
  maxAttempts?: number;
}

export interface SendOptions {
  signal?: AbortSignal;
}

export interface Session extends AsyncDisposable {
  readonly conversationId: string | null;
  send(prompt: string, opts?: SendOptions): AsyncIterable<AgyEvent>;
  cancel(): void;
  close(): Promise<void>;
}

export interface Runtime {
  session(opts?: { resume?: string }): Promise<Session>;
  run(prompt: string, opts?: RunOptions): Promise<RunResult>;
  step<T>(opts: StepOptions<T>): Promise<T>;
  quota(opts?: { timeoutMs?: number }): Promise<QuotaPools>;
}

type CommonArgOptions = { model?: string; effort?: Effort };

interface RuntimeContext {
  bin: string;
  cwd: string | undefined;
  env: NodeJS.ProcessEnv;
  spawnProc: (args: string[]) => ProcLike;
  commonArgs: (opts: CommonArgOptions) => string[];
  defaultTimeoutMs: number;
  warn: (message: string) => void;
}

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_LINE_PREVIEW = 160;

function truncate(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > MAX_LINE_PREVIEW ? `${single.slice(0, MAX_LINE_PREVIEW)}…` : single;
}

function waitForExit(proc: ProcLike): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      resolve({ code, signal });
    };
    proc.on("error", () => finish(null, null));
    proc.on("close", (code: number | null, signal: NodeJS.Signals | null) => finish(code ?? null, signal ?? null));
  });
}

function capture(stream: Readable | null, onData: (chunk: string) => void): void {
  stream?.on("data", (chunk: unknown) => onData(String(chunk)));
}

class AgySession implements Session {
  readonly #ctx: RuntimeContext;
  #proc: ProcLike | null = null;
  #reader: Interface | null = null;
  #conversationId: string | null = null;
  #resumeId: string | null;
  #pending: AgyEvent[] = [];
  #wake: (() => void) | null = null;
  #exited = false;
  #exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  #exitResolve: (() => void) | null = null;
  #exitPromise: Promise<void>;
  #stderr = "";
  #busy = false;
  #closed = false;

  constructor(ctx: RuntimeContext, resume?: string) {
    this.#ctx = ctx;
    this.#resumeId = resume ?? null;
    this.#exitPromise = new Promise((resolve) => {
      this.#exitResolve = resolve;
    });
  }

  get conversationId(): string | null {
    return this.#conversationId;
  }

  #ensureProc(): ProcLike {
    if (this.#closed) throw new AgyError("protocol", "session is closed");
    if (this.#proc) return this.#proc;
    const args = [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--print-timeout",
      formatDuration(this.#ctx.defaultTimeoutMs),
      ...this.#ctx.commonArgs({}),
    ];
    if (this.#resumeId) args.push("--conversation", this.#resumeId);
    const proc = this.#ctx.spawnProc(args);
    this.#proc = proc;
    capture(proc.stderr, (chunk) => {
      this.#stderr += chunk;
    });
    proc.on("error", () => {
      this.#exited = true;
      this.#wake?.();
      this.#exitResolve?.();
    });
    proc.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      this.#exited = true;
      this.#exitInfo = { code: code ?? null, signal: signal ?? null };
      this.#wake?.();
      this.#exitResolve?.();
    });
    if (proc.stdout) {
      this.#reader = createInterface({ input: proc.stdout });
      this.#reader.on("line", (line: string) => {
        const event = parseEvent(line);
        if (!event) {
          if (line.trim()) this.#ctx.warn(`agy-sdk: unrecognized stream line: ${truncate(line)}`);
          return;
        }
        if (event.event === "init") this.#conversationId = event.conversation_id;
        this.#pending.push(event);
        this.#wake?.();
      });
    }
    return proc;
  }

  #exitKind(): AgyErrorKind {
    if (!this.#stderr.trim()) return "spawn";
    const kind = classifyError(this.#stderr);
    return kind === "run" ? "spawn" : kind;
  }

  async *send(prompt: string, opts: SendOptions = {}): AsyncIterable<AgyEvent> {
    if (this.#busy) throw new AgyError("protocol", "send() called while a previous turn is still running");
    const proc = this.#ensureProc();
    this.#busy = true;
    const onAbort = () => this.cancel();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (!proc.stdin) throw new AgyError("spawn", "agy stdin is not writable");
      proc.stdin.write(JSON.stringify({ event: "user", message: { content: prompt } }) + "\n");
      for (;;) {
        while (this.#pending.length > 0) {
          const event = this.#pending.shift();
          if (!event) continue;
          yield event;
          if (event.event === "result") return;
        }
        if (this.#exited) {
          const { code } = this.#exitInfo ?? { code: null };
          throw new AgyError(
            this.#exitKind(),
            `agy session ended before producing a result (exit ${code ?? "null"})`,
            { stderr: this.#stderr },
          );
        }
        await new Promise<void>((resolve) => {
          this.#wake = resolve;
        });
        this.#wake = null;
      }
    } finally {
      this.#busy = false;
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  cancel(): void {
    this.#proc?.kill("SIGINT");
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#reader?.close();
    const proc = this.#proc;
    if (!proc) return;
    try {
      proc.stdin?.end();
    } catch {}
    if (!this.#exited) {
      const timer = setTimeout(() => proc.kill("SIGKILL"), 1_000);
      timer.unref?.();
      await this.#exitPromise;
      clearTimeout(timer);
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

export function createRuntime(options: RuntimeOptions = {}): Runtime {
  const bin = options.bin ?? "agy";
  const warn = options.onWarning ?? ((message: string) => console.error(message));
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawnPort = options.spawn ?? defaultSpawn;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(options.home ? { HOME: options.home } : {}),
    ...options.env,
  };

  const commonArgs = (opts: CommonArgOptions): string[] => {
    const args: string[] = [];
    const model = opts.model ?? options.model;
    const effort = opts.effort ?? options.effort;
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    return args;
  };

  const ctx: RuntimeContext = {
    bin,
    cwd: options.cwd,
    env,
    defaultTimeoutMs,
    warn,
    commonArgs,
    spawnProc: (args) => spawnPort(bin, [...args, ...(options.extraArgs ?? [])], { cwd: options.cwd, env }),
  };

  const run = async (prompt: string, opts: RunOptions = {}): Promise<RunResult> => {
    const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs;
    const args = ["-p", prompt, "--output-format", "json", "--print-timeout", formatDuration(timeoutMs), ...commonArgs(opts)];
    if (opts.schema !== undefined) {
      args.push("--json-schema", typeof opts.schema === "string" ? opts.schema : JSON.stringify(opts.schema));
    }
    if (opts.resume) args.push("--conversation", opts.resume);
    else if (opts.continueLatest) args.push("--continue");

    const proc = ctx.spawnProc(args);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError: Error | null = null;
    capture(proc.stdout, (chunk) => {
      stdout += chunk;
    });
    capture(proc.stderr, (chunk) => {
      stderr += chunk;
    });
    proc.on("error", (error: Error) => {
      spawnError = error;
    });
    const onAbort = () => proc.kill("SIGINT");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs + 1_000);
    timer.unref?.();

    const { code } = await waitForExit(proc);
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);

    if (spawnError) throw new AgyError("spawn", `failed to start ${bin}: ${(spawnError as Error).message}`, spawnError);
    if (timedOut) throw new AgyError("timeout", `agy run exceeded ${timeoutMs}ms`, { stdout, stderr });
    const envelope = extractEnvelope(stdout);
    if (!envelope) {
      throw new AgyError(classifyError(`${stderr}\n${stdout}`), `agy did not return a result (exit ${code ?? "null"})`, {
        stdout,
        stderr,
        code,
      });
    }
    if (envelope.status !== "SUCCESS") {
      const message = envelope.error ?? `run ended with status ${envelope.status}`;
      throw new AgyError(classifyError(message), message, envelope);
    }
    return envelope;
  };

  const quota = async (opts: { timeoutMs?: number } = {}): Promise<QuotaPools> => {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const proc = ctx.spawnProc(["-p", "/usage"]);
    let stdout = "";
    let stderr = "";
    capture(proc.stdout, (chunk) => {
      stdout += chunk;
    });
    capture(proc.stderr, (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    timer.unref?.();
    await waitForExit(proc);
    clearTimeout(timer);
    const pools = parseUsage(stdout);
    const known = Object.keys(pools.gemini).length > 0 || Object.keys(pools.claude).length > 0;
    if (!known) {
      const kind = classifyError(stderr || stdout, "auth");
      throw new AgyError(kind, "could not read quota from agy /usage", { stdout, stderr });
    }
    return pools;
  };

  const step = async <T>(opts: StepOptions<T>): Promise<T> => {
    const maxAttempts = opts.maxAttempts ?? 2;
    const parse = opts.parse ?? ((result: RunResult) => extractStructured<T>(result));
    let prompt = opts.prompt;
    let lastProblem = "unknown";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await run(prompt, opts);
      let value: T;
      try {
        value = parse(result);
      } catch (error) {
        lastProblem = `output could not be parsed: ${error instanceof Error ? error.message : String(error)}`;
        if (attempt === maxAttempts) throw new AgyError("protocol", `step failed after ${maxAttempts} attempts: ${lastProblem}`, { result });
        prompt = `${opts.prompt}\n\nPrevious attempt failed: ${lastProblem}\nReturn only valid JSON matching the schema.`;
        continue;
      }
      const problem = opts.validate ? await opts.validate(value) : null;
      if (!problem) return value;
      lastProblem = problem;
      if (attempt === maxAttempts) {
        throw new AgyError("protocol", `step failed validation after ${maxAttempts} attempts: ${problem}`, { value, result });
      }
      prompt = `${opts.prompt}\n\nPrevious attempt failed validation: ${problem}\nFix the issue and return the corrected JSON only.`;
    }
    throw new AgyError("protocol", `step failed: ${lastProblem}`);
  };

  return {
    session: async (opts) => new AgySession(ctx, opts?.resume),
    run,
    step,
    quota,
  };
}
