import test from "node:test";
import assert from "node:assert/strict";
import { AgyError, createRuntime } from "../src/index.ts";
import { envelope, fakeSpawn } from "../src/testing/fake-proc.ts";

test("step retries with validation feedback and returns the fixed value", async () => {
  const prompts: string[] = [];
  let calls = 0;
  const spawn = fakeSpawn((args, proc) => {
    prompts.push(args[1] ?? "");
    calls += 1;
    setImmediate(() => {
      const lines = calls === 1 ? ["a"] : ["a", "b"];
      proc.stdout.write(envelope({ response: JSON.stringify({ lines }), structured_output: { lines } }) + "\n");
      proc.exit(0);
    });
  });
  const runtime = createRuntime({ spawn });
  const value = await runtime.step<{ lines: string[] }>({
    prompt: "Translate two lines",
    schema: { type: "object", properties: { lines: { type: "array", items: { type: "string" } } } },
    validate: (output) => (output.lines.length === 2 ? null : "expected 2 lines"),
    maxAttempts: 2,
    timeoutMs: 2_000,
  });
  assert.deepEqual(value, { lines: ["a", "b"] });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1] ?? "", /expected 2 lines/);
});

test("step throws a protocol error after exhausting attempts", async () => {
  const spawn = fakeSpawn((_args, proc) => {
    setImmediate(() => {
      proc.stdout.write(envelope({ response: JSON.stringify({ lines: ["a"] }), structured_output: { lines: ["a"] } }) + "\n");
      proc.exit(0);
    });
  });
  const runtime = createRuntime({ spawn });
  await assert.rejects(
    runtime.step<{ lines: string[] }>({
      prompt: "Translate two lines",
      schema: { type: "object" },
      validate: (output) => (output.lines.length === 2 ? null : "expected 2 lines"),
      maxAttempts: 2,
      timeoutMs: 2_000,
    }),
    (error: unknown) => error instanceof AgyError && error.kind === "protocol" && /expected 2 lines/.test(error.message),
  );
});

test("step treats a throwing validator as a retryable problem", async () => {
  let calls = 0;
  const spawn = fakeSpawn((_args, proc) => {
    calls += 1;
    setImmediate(() => {
      proc.stdout.write(envelope({ response: JSON.stringify({ wrong: true }), structured_output: { wrong: true } }) + "\n");
      proc.exit(0);
    });
  });
  const runtime = createRuntime({ spawn });
  await assert.rejects(
    runtime.step<{ lines: string[] }>({
      prompt: "Return lines",
      schema: { type: "object" },
      validate: (value) => (value.lines.length === 2 ? null : "expected 2 lines"),
      maxAttempts: 2,
      timeoutMs: 2_000,
    }),
    (error: unknown) => error instanceof AgyError && error.kind === "protocol" && /validator threw/.test(error.message),
  );
  assert.equal(calls, 2);
});

test("step falls back to JSON parsing when structured_output is absent", async () => {
  const spawn = fakeSpawn((_args, proc) => {
    setImmediate(() => {
      proc.stdout.write(envelope({ response: '```json\n{"ok":true}\n```' }) + "\n");
      proc.exit(0);
    });
  });
  const runtime = createRuntime({ spawn });
  const value = await runtime.step<{ ok: boolean }>({
    prompt: "Return ok",
    schema: { type: "object" },
    timeoutMs: 2_000,
  });
  assert.deepEqual(value, { ok: true });
});
