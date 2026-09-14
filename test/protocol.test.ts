import test from "node:test";
import assert from "node:assert/strict";
import { extractEnvelope, extractStructured, parseEvent, stripCodeFence } from "../src/protocol/parse.ts";
import { fixture } from "../src/testing/fake-proc.ts";

test("parseEvent parses init, step_update and result", () => {
  const init = parseEvent(fixture.init("conv-7"));
  assert.ok(init && init.event === "init" && init.conversation_id === "conv-7");

  const step = parseEvent(fixture.text("hello"));
  assert.ok(step && step.event === "step_update" && step.step_update.text_delta === "hello");

  const result = parseEvent(fixture.result("done"));
  assert.ok(result && result.event === "result" && result.result.status === "SUCCESS");
});

test("parseEvent ignores blank, non-JSON, unknown and malformed lines", () => {
  assert.equal(parseEvent(""), null);
  assert.equal(parseEvent("not json"), null);
  assert.equal(parseEvent('{"event":"future_thing"}'), null);
  assert.equal(parseEvent('{"event":"init"}'), null);
  assert.equal(parseEvent('{"event":"result","result":"nope"}'), null);
});

test("extractEnvelope finds the result line among noise", () => {
  const stdout = ["diagnostic text", envelopeLine({ response: "hi" }), ""].join("\n");
  const result = extractEnvelope(stdout);
  assert.equal(result?.response, "hi");
});

test("extractEnvelope returns null when no envelope exists", () => {
  assert.equal(extractEnvelope("some text\n"), null);
});

test("extractStructured prefers structured_output and falls back to JSON in response", () => {
  const withStructured = extractStructured<{ a: number }>({
    conversation_id: "c",
    status: "SUCCESS",
    response: "ignored",
    structured_output: { a: 1 },
  });
  assert.deepEqual(withStructured, { a: 1 });

  const withFence = extractStructured<{ a: number }>({
    conversation_id: "c",
    status: "SUCCESS",
    response: "```json\n{\"a\":2}\n```",
  });
  assert.deepEqual(withFence, { a: 2 });
});

test("stripCodeFence unwraps fenced blocks only", () => {
  assert.equal(stripCodeFence("```json\n{\"a\":1}\n```"), '{"a":1}');
  assert.equal(stripCodeFence('{"a":1}'), '{"a":1}');
});

function envelopeLine(result: Record<string, unknown>): string {
  return JSON.stringify({ conversation_id: "conv-1", status: "SUCCESS", response: "", ...result });
}
