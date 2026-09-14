import { createRuntime } from "../src/index.ts";

// node examples/hello.ts
// Minimal one-shot: run a prompt, print text, read token usage.

const agy = createRuntime({ model: "gemini-3.8-flash-low", effort: "low" });

const result = await agy.run("In one sentence: what is prompt caching?", { timeoutMs: 120_000 });

console.log(result.response.trim());
console.error(`tokens: ${result.usage?.total_tokens ?? "?"} (cache read: ${result.usage?.cache_read_tokens ?? 0})`);
