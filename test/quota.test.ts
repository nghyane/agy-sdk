import test from "node:test";
import assert from "node:assert/strict";
import { formatDuration, parseUsage, remainingPct } from "../src/quota.ts";

const TAB_FIXTURE = [
  "Gemini Models\tWeekly Limit Remaining\t96%\t2026-09-18T06:56:09Z",
  "Gemini Models\tFive Hour Limit Remaining\t100%\t2026-09-14T12:54:04Z",
  "Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-09-21T08:14:01Z",
  "Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-09-14T13:14:01Z",
].join("\n");

test("parseUsage parses tab separated output", () => {
  const pools = parseUsage(TAB_FIXTURE);
  assert.equal(pools.gemini.weekly?.pct, 96);
  assert.equal(pools.gemini.weekly?.resetAt, "2026-09-18T06:56:09Z");
  assert.equal(pools.gemini.fiveHour?.pct, 100);
  assert.equal(pools.claude.weekly?.pct, 100);
  assert.equal(pools.claude.fiveHour?.resetAt, "2026-09-14T13:14:01Z");
});

test("parseUsage tolerates space separated output and skips junk", () => {
  const pools = parseUsage("header\nGemini Models    Weekly Limit Remaining    45%    2026-09-18T06:56:09Z\nrandom");
  assert.equal(pools.gemini.weekly?.pct, 45);
  assert.deepEqual(pools.claude, {});
});

test("parseUsage returns empty pools for empty input", () => {
  assert.deepEqual(parseUsage(""), { gemini: {}, claude: {} });
});

test("remainingPct returns the lowest window and null when unknown", () => {
  const pools = parseUsage(TAB_FIXTURE);
  assert.equal(remainingPct(pools, "gemini"), 96);
  assert.equal(remainingPct(pools, "claude"), 100);
  assert.equal(remainingPct(parseUsage(""), "gemini"), null);
});

test("formatDuration renders go-style durations", () => {
  assert.equal(formatDuration(300_000), "5m0s");
  assert.equal(formatDuration(90_000), "1m30s");
  assert.equal(formatDuration(500), "0m1s");
});
