import test from "node:test";
import assert from "node:assert/strict";
import { AgyError, createRuntime } from "../src/index.ts";
import { envelope, fakeSpawn, fixture, FakeProc } from "../src/testing/fake-proc.ts";

const USAGE_FIXTURE = [
  "Gemini Models\tWeekly Limit Remaining\t96%\t2026-09-18T06:56:09Z",
  "Gemini Models\tFive Hour Limit Remaining\t100%\t2026-09-14T12:54:04Z",
  "Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-09-21T08:14:01Z",
  "Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-09-14T13:14:01Z",
  "",
].join("\n");

test("session streams events and keeps the conversation across turns", async () => {
  const procs: FakeProc[] = [];
  const spawn = fakeSpawn((_args, proc) => {
    procs.push(proc);
    let turn = 0;
    proc.onWrite = () => {
      turn += 1;
      if (turn === 1) {
        proc.reply([fixture.init(), fixture.text("hello "), fixture.text("world", "conv-1", "DONE"), fixture.result("hello world")]);
      } else {
        proc.reply([fixture.result("second answer", "conv-1", { num_turns: 2 })]);
      }
    };
  });
  const runtime = createRuntime({ spawn });
  const session = await runtime.session();

  const deltas: string[] = [];
  for await (const event of session.send("hi")) {
    if (event.event === "step_update" && event.step_update.text_delta) deltas.push(event.step_update.text_delta);
  }
  assert.deepEqual(deltas, ["hello ", "world"]);
  assert.equal(session.conversationId, "conv-1");

  let second = "";
  for await (const event of session.send("more")) {
    if (event.event === "result") second = event.result.response;
  }
  assert.equal(second, "second answer");
  assert.equal(procs[0]?.writes.length, 2);

  await session.close();
  assert.ok(procs[0]?.exited);
});

test("session passes --conversation when resuming", async () => {
  const seen: string[][] = [];
  const spawn = fakeSpawn((args, proc) => {
    seen.push(args);
    proc.onWrite = () => proc.reply([fixture.result("ok")]);
  });
  const runtime = createRuntime({ spawn });
  await using session = await runtime.session({ resume: "conv-9" });
  for await (const _event of session.send("x")) {
    // drain
  }
  const args = seen[0] ?? [];
  assert.ok(args.includes("--input-format") && args.includes("stream-json"));
  assert.ok(args.includes("--conversation") && args.includes("conv-9"));
});

test("session surfaces classified failures when the process dies mid-turn", async () => {
  const spawn = fakeSpawn((_args, proc) => {
    proc.onWrite = () => {
      proc.stderr.write("Authentication required. Please log in.\n");
      proc.exit(1);
    };
  });
  const runtime = createRuntime({ spawn });
  const session = await runtime.session();
  await assert.rejects(
    (async () => {
      for await (const _event of session.send("hi")) {
        // drain
      }
    })(),
    (error: unknown) => error instanceof AgyError && error.kind === "auth",
  );
});

test("cancel sends SIGINT to the running process", async () => {
  const procs: FakeProc[] = [];
  const spawn = fakeSpawn((_args, proc) => {
    procs.push(proc);
  });
  const runtime = createRuntime({ spawn });
  const session = await runtime.session();
  const iterator = session.send("hi")[Symbol.asyncIterator]();
  const pending = iterator.next();
  await new Promise((resolve) => setTimeout(resolve, 20));
  session.cancel();
  await pending.catch(() => {});
  assert.equal(procs[0]?.killedWith, "SIGINT");
});

test("run returns the JSON envelope and forwards flags", async () => {
  const seen: string[][] = [];
  const spawn = fakeSpawn((args, proc) => {
    seen.push(args);
    setImmediate(() => {
      proc.stdout.write(envelope({ response: "42" }) + "\n");
      proc.exit(0);
    });
  });
  const runtime = createRuntime({ spawn, model: "gemini-3.8-flash-low" });
  const result = await runtime.run("answer this", { schema: { type: "object" }, timeoutMs: 2_000 });
  assert.equal(result.response, "42");
  const args = seen[0] ?? [];
  assert.ok(args.includes("--output-format") && args.includes("json"));
  assert.ok(args.includes("--json-schema"));
  assert.ok(args.includes("--model") && args.includes("gemini-3.8-flash-low"));
  assert.ok(args.includes("--print-timeout"));
});

test("run maps quota failures to AgyError kind quota", async () => {
  const spawn = fakeSpawn((_args, proc) => {
    setImmediate(() => {
      proc.stdout.write(envelope({ status: "ERROR", error: "You have exhausted your quota on this model." }) + "\n");
      proc.exit(1);
    });
  });
  const runtime = createRuntime({ spawn });
  await assert.rejects(runtime.run("x", { timeoutMs: 2_000 }), (error: unknown) => error instanceof AgyError && error.kind === "quota");
});

test("run enforces a hard timeout and kills the process", async () => {
  const procs: FakeProc[] = [];
  const spawn = fakeSpawn((_args, proc) => {
    procs.push(proc);
  });
  const runtime = createRuntime({ spawn, defaultTimeoutMs: 50 });
  await assert.rejects(runtime.run("x", { timeoutMs: 50 }), (error: unknown) => error instanceof AgyError && error.kind === "timeout");
  assert.equal(procs[0]?.killedWith, "SIGKILL");
});

test("quota parses /usage output", async () => {
  const spawn = fakeSpawn((args, proc) => {
    assert.deepEqual(args.slice(0, 2), ["-p", "/usage"]);
    setImmediate(() => {
      proc.stdout.write(USAGE_FIXTURE);
      proc.exit(0);
    });
  });
  const runtime = createRuntime({ spawn });
  const pools = await runtime.quota();
  assert.equal(pools.gemini.weekly?.pct, 96);
  assert.equal(pools.claude.fiveHour?.pct, 100);
});

test("quota raises auth errors when the account is not usable", async () => {
  const spawn = fakeSpawn((_args, proc) => {
    setImmediate(() => {
      proc.stderr.write("Authentication required. Please log in.\n");
      proc.exit(1);
    });
  });
  const runtime = createRuntime({ spawn });
  await assert.rejects(runtime.quota(), (error: unknown) => error instanceof AgyError && error.kind === "auth");
});
