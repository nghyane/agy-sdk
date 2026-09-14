import { createRuntime, remainingPct } from "../src/index.ts";

// node examples/quota-guard.ts
// Cron-friendly guard: run a batch only when the Gemini pool has room.
// Exit code 2 = "skip this run, quota too low" (nothing was spent on the model).

const MIN_REMAINING = Number(process.env.MIN_REMAINING ?? 20);

const agy = createRuntime({ model: "gemini-3.8-flash-low", effort: "low" });
const pools = await agy.quota();
const remaining = remainingPct(pools, "gemini");

if (remaining === null) {
  console.error("quota unknown (auth problem?)");
  process.exit(1);
}

if (remaining < MIN_REMAINING) {
  const resetAt = pools.gemini.fiveHour?.resetAt ?? pools.gemini.weekly?.resetAt ?? "unknown";
  console.error(`gemini pool at ${remaining}% (< ${MIN_REMAINING}%) — retry after ${resetAt}`);
  process.exit(2);
}

console.error(`gemini pool at ${remaining}% — running batch`);

const result = await agy.run("Say exactly: batch started", { timeoutMs: 60_000 });
console.log(result.response.trim());
