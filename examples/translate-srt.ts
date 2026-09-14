import { readFile, writeFile } from "node:fs/promises";
import { createRuntime } from "../src/index.ts";

// Usage: node --experimental-strip-types examples/translate-srt.ts ep01.srt ep01.vi.srt [model]
//
// Demonstrates the practical shape of an agy-sdk pipeline:
//   deterministic parsing -> agent step per chunk (typed + validated) -> deterministic merge.

interface Cue {
  index: string;
  time: string;
  text: string;
}

interface TranslatedChunk {
  lines: string[];
}

const [input = "ep01.srt", output = "ep01.vi.srt", model = "gemini-3.8-flash-low"] = process.argv.slice(2);

function parseSrt(content: string): Cue[] {
  return content
    .replace(/\r\n/g, "\n")
    .split("\n\n")
    .map((block) => block.split("\n"))
    .filter((lines) => lines.length >= 2)
    .map((lines) => ({
      index: lines[0] ?? "0",
      time: lines[1] ?? "",
      text: lines.slice(2).join("\n"),
    }));
}

function toSrt(cues: Cue[]): string {
  return cues.map((cue) => `${cue.index}\n${cue.time}\n${cue.text}`).join("\n\n") + "\n";
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

const runtime = createRuntime({ model, effort: "low" });
const source = await readFile(input, "utf8");
const cues = parseSrt(source);
const batches = chunk(cues, 40);
const translated: Cue[] = [];

for (const [batchIndex, batch] of batches.entries()) {
  const payload = JSON.stringify(batch.map((cue) => cue.text));
  const result = await runtime.step<TranslatedChunk>({
    prompt: [
      "Translate the subtitle lines below to Vietnamese.",
      `Return JSON only, exactly this shape: {"lines": [...]} with ${batch.length} strings, same order.`,
      "Keep names and onomatopoeia; keep each line short enough for subtitles.",
      "",
      `Input JSON array: ${payload}`,
    ].join("\n"),
    schema: {
      type: "object",
      properties: { lines: { type: "array", items: { type: "string" } } },
      required: ["lines"],
    },
    validate: (value) => {
      if (!Array.isArray(value.lines)) return "lines must be an array of strings";
      if (value.lines.length !== batch.length) return `expected ${batch.length} lines, got ${value.lines.length}`;
      if (!value.lines.every((line) => typeof line === "string")) return "every line must be a string";
      return null;
    },
    maxAttempts: 3,
    timeoutMs: 300_000,
  });

  for (const [i, cue] of batch.entries()) {
    translated.push({ ...cue, text: result.lines[i] ?? cue.text });
  }
  console.error(`translated chunk ${batchIndex + 1}/${batches.length}`);
}

await writeFile(output, toSrt(translated), "utf8");
console.error(`wrote ${output}`);
