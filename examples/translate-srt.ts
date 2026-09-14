import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRuntime } from "../src/index.ts";

// File-first pipeline: the agent works on files inside an isolated workspace;
// the SDK only stages inputs and validates outputs from disk (no JSON round-trips of content).
//
//   node examples/translate-srt.ts ep01.srt ep01.vi.srt [model]
//
// Headless notes (agy 1.2.x), verified:
//   - print/session mode has no default workspace -> register one with --add-dir <dir>
//   - file tools are soft-denied when approval cannot be prompted -> --dangerously-skip-permissions
//     (pair with --sandbox to bound shell commands)

const [input = "ep01.srt", output = "ep01.vi.srt", model = "gemini-3.8-flash-low"] = process.argv.slice(2);
const source = await readFile(input, "utf8");

const workspace = await mkdtemp(join(tmpdir(), "agy-srt-"));
try {
  await writeFile(join(workspace, "input.srt"), source, "utf8");

  const agy = createRuntime({
    cwd: workspace,
    model,
    effort: "low",
    extraArgs: ["--add-dir", workspace, "--dangerously-skip-permissions", "--sandbox"],
  });

  const result = await agy.run(
    [
      "Translate the subtitle text in input.srt to Vietnamese.",
      "Keep cue numbers and timing lines byte-identical; keep names; keep each line short.",
      "Write the result to output.srt in the same SRT format.",
      "Reply with just the filename when done.",
    ].join(" "),
    { timeoutMs: 600_000 },
  );
  if (result.status !== "SUCCESS") throw new Error(`translate failed with status ${result.status}`);

  const translated = await readFile(join(workspace, "output.srt"), "utf8");
  assertSameCues(source, translated);
  await writeFile(resolve(output), translated, "utf8");
  console.error(`translated ${countCues(source)} cues -> ${output} (tokens: ${result.usage?.total_tokens})`);
} finally {
  await rm(workspace, { recursive: true, force: true });
}

function countCues(text: string): number {
  return text.replace(/\r\n/g, "\n").split("\n\n").filter((block) => block.trim() !== "").length;
}

function timingLines(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.includes("-->"));
}

function assertSameCues(source: string, translated: string): void {
  if (!translated.trim()) throw new Error("translated file is empty");
  if (countCues(source) !== countCues(translated)) throw new Error("cue count changed");
  const before = timingLines(source);
  const after = timingLines(translated);
  if (before.length !== after.length || before.some((line, index) => line !== after[index])) {
    throw new Error("timing lines changed");
  }
}
