# @nghyane/agy-sdk

**Unofficial TypeScript SDK for the Antigravity CLI (`agy`) headless mode** — typed sessions, streaming events, validated steps and quota awareness, built only on documented `agy` flags.

[![CI](https://github.com/nghyane/agy-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/nghyane/agy-sdk/actions/workflows/ci.yml)
[![node](https://img.shields.io/badge/node-%3E%3D22.6-brightgreen)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

> **Not affiliated with Google.** This project drives the official `agy` binary through its
> documented headless interface (`--input-format stream-json`, `--output-format stream-json`,
> `--json-schema`, `--conversation`, `/usage`). It never reads, copies or exports OAuth
> credentials. Do not use it to bypass subscription limits or third-party access policies.

## Why

Automating agents is repetitive: spawn a process, parse NDJSON, track a conversation, retry
after a validation failure, watch quota. This SDK packages exactly that:

- **Subscription-friendly** — runs the real `agy` binary, so usage bills to your existing
  Antigravity login (Google AI Pro/Ultra), not to a separate API key.
- **No protocol reverse engineering** — only documented flags and event shapes.
- **Typed everything** — discriminated unions for events, typed errors (`quota`, `auth`,
  `model`, `timeout`, ...), schema-validated step outputs.
- **Testable** — the spawn layer is a port; the test suite runs entirely on fixtures, no
  `agy` binary or quota required.

## Requirements

- `agy` installed and authenticated once (`agy` interactive login).
- Node.js **>= 22.6**.
- Runtime usage is subprocess-based: this SDK is ESM-only.

## Install

```bash
# from GitHub until the package is published to npm
npm install github:nghyane/agy-sdk
```

## Quick start

```ts
import { createRuntime } from "@nghyane/agy-sdk";

const agy = createRuntime({ model: "gemini-3.8-flash-low", effort: "low" });

// One-shot, machine-readable
const result = await agy.run("Summarize what this repo does in one sentence.");
console.log(result.response, result.usage);

// Typed, validated step — retries with feedback until the output satisfies you
interface Outline { sections: Array<{ title: string; points: string[] }> }

const outline = await agy.step<Outline>({
  prompt: "Draft an outline for a blog post about edge caching.",
  schema: { type: "object", properties: { sections: { type: "array" } }, required: ["sections"] },
  validate: (value) => (value.sections.length >= 3 ? null : "need at least 3 sections"),
  maxAttempts: 3,
});

// Persistent session — one process, many turns, warm context
await using session = await agy.session();
for await (const event of session.send("Remember the outline above.")) {
  if (event.event === "step_update" && event.step_update.text_delta) process.stdout.write(event.step_update.text_delta);
  if (event.event === "result") console.log("\ndone:", event.result.status);
}

// Quota is a first-class citizen (free probe, no model call)
const quota = await agy.quota();
console.log("gemini:", quota.gemini.fiveHour, "claude:", quota.claude.fiveHour);
```

See [`examples/translate-srt.ts`](./examples/translate-srt.ts) for a full multi-step pipeline
(parse SRT → chunked agent steps with validation → merge).

## API

### `createRuntime(options?)`

| Option | Default | Description |
| --- | --- | --- |
| `bin` | `"agy"` | Binary name or path |
| `home` | inherited | `HOME` for the child process — isolates login/conversations per account or workspace |
| `cwd` | inherited | Working directory |
| `model` / `effort` | — | Defaults for every call (`--model`, `--effort`) |
| `extraArgs` | `[]` | Extra args appended to every invocation |
| `env` | — | Extra environment variables |
| `spawn` | `node:child_process` | Spawn port, injected in tests |
| `defaultTimeoutMs` | `300000` | Default run/turn timeout (`--print-timeout`) |
| `onWarning` | `console.error` | Called for unrecognized stream lines |

### `runtime.run(prompt, options?) → RunResult`

One-shot `agy -p … --output-format json`. Returns the JSON envelope (`status`, `response`,
`usage`, `conversation_id`, `structured_output`, …). Throws `AgyError` when the run fails,
with `kind` classified from the failure text.

Options: `schema`, `model`, `effort`, `timeoutMs`, `resume` (conversation id),
`continueLatest`, `signal`.

### `runtime.session(options?) → Session`

Spawns one `agy --input-format stream-json --output-format stream-json` process and keeps it
alive across turns.

- `session.send(prompt, { signal })` — async iterable of `init | step_update | result`; one
  turn per call, resolved by its `result` event.
- `session.conversationId` — set after `init`; pass it back via `session({ resume })` to
  continue after a crash.
- `session.cancel()` — sends `SIGINT`.
- `await session.close()` / `await using` — closes stdin, then `SIGKILL` after a grace period.

### `runtime.step<T>(options) → T`

Typed, validated unit of work:

```ts
const value = await agy.step<Translated>({
  prompt,                     // re-sent with feedback on retry
  schema,                     // enforced by agy --json-schema
  parse,                      // default: structured_output, else JSON in response
  validate: (v) => problem,   // return a string to retry, null to accept
  maxAttempts: 3,
});
```

Quota/auth/model errors propagate as `AgyError` — the caller decides whether to retry, wait
for a reset, or fail.

### `runtime.quota() → QuotaPools`

Runs `agy -p /usage` (CLI-local, **no model call, no quota consumption**) and parses the two
independent pools:

```ts
{ gemini: { weekly: { pct, resetAt }, fiveHour: { … } },
  claude: { weekly: { pct, resetAt }, fiveHour: { … } } }
```

### Errors

```ts
try {
  await agy.run("…");
} catch (error) {
  if (error instanceof AgyError && error.kind === "quota") {
    // inspect error.detail for the raw envelope
  }
}
```

`kind` is one of `spawn | auth | quota | model | timeout | protocol | run`.

## Data handling

The SDK is a local process wrapper, nothing more:

- No network calls, no telemetry, no analytics — the only network traffic is `agy` itself.
- No filesystem access: conversations and config live in the account's `HOME` and are managed by `agy`.
- `response` values are passed through verbatim; nothing is rewritten. `step()` derives a typed
  value for validation but returns or rejects the original result untouched.
- The only content that leaves the process is `onWarning` output for unrecognized stream lines
  (truncated). Disable it with `createRuntime({ onWarning: () => {} })`, or consume raw events
  via `session.send()` if you want zero interpretation.

## How it works

```
your code
   │  typed API (run / session / step / quota)
   ▼
runtime.ts ── spawns ──▶ agy (official binary, your login)
   │                        │  NDJSON events on stdout
   ▼                        ▼
protocol/parse.ts       protocol/types.ts
   (single parser for init | step_update | result, fixtures-tested)
```

- One parser, one schema layer — no regex scattered across the codebase.
- The spawn port is the only OS boundary, which is why the whole test suite runs on fixtures.
- Errors are classified in one place (`errors.ts`), never by ad-hoc string matching.

## Quota and cost notes (measured)

- Every `agy` invocation carries a large fixed context: a trivial turn costs ~13k input
  tokens. Budget per step, not per request.
- Gemini and Claude/GPT models draw from **separate pools** with independent 5-hour and
  weekly windows — routing editing/QC steps to Claude does not consume Gemini quota.
- `agy -p /usage` is free and returns exact percentages plus reset timestamps; schedule heavy
  batches against `resetAt` instead of guessing.
- `usage` in a `result` is cumulative for the session; compute deltas per turn when
  attributing cost.
- Accounts that share a family plan can report identical quota — verify with `/usage` before
  assuming multiple accounts add capacity.

## Testing

```bash
npm test        # node:test + fixtures, no agy required
npm run typecheck
npm run build
```

The `@nghyane/agy-sdk/testing` subpath exports `FakeProc` / `fakeSpawn` / `fixture` builders
used by this repo, so downstream integrations can test without spawning the real binary.

## Roadmap

- Hook middleware (pre/post tool decisions) with fail-closed semantics.
- ACP bridge for editor clients.
- Optional scheduler helpers (quota-aware queues, cooldowns).

## License

[MIT](./LICENSE)
