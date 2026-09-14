import { writeFile } from "node:fs/promises";
import { createRuntime } from "../src/index.ts";

// node examples/blog.ts "How DNS resolution works"
// Multi-step pipeline: typed outline -> draft per section -> polish on the Claude pool -> write markdown.

interface Outline {
  title: string;
  sections: Array<{ heading: string; points: string[] }>;
}

const topic = process.argv[2] ?? "How DNS resolution works";
const gemini = createRuntime({ model: "gemini-3.8-flash-low", effort: "low" });
const claude = createRuntime({ model: "claude-sonnet-4-6" });

// 1. Outline — structured and validated; retries with feedback until it satisfies the checks.
const outline = await gemini.step<Outline>({
  prompt: [
    `Outline a short technical blog post about: ${topic}`,
    'Return JSON only: {"title": string, "sections": [{"heading": string, "points": string[]}]} with exactly 2 sections and 2-3 points each.',
  ].join("\n"),
  schema: {
    type: "object",
    properties: {
      title: { type: "string" },
      sections: {
        type: "array",
        items: { type: "object", properties: { heading: { type: "string" }, points: { type: "array", items: { type: "string" } } } },
      },
    },
    required: ["title", "sections"],
  },
  validate: (value) => {
    if (!Array.isArray(value.sections) || value.sections.length !== 2) return "need exactly 2 sections";
    if (value.sections.some((section) => !Array.isArray(section.points) || section.points.length < 2)) return "each section needs 2-3 points";
    return null;
  },
  maxAttempts: 3,
  timeoutMs: 180_000,
});
console.error(`outline: ${outline.title} (${outline.sections.length} sections)`);

// 2. Draft each section — plain-text step, validated by length.
const drafts: string[] = [];
for (const [index, section] of outline.sections.entries()) {
  const draft = await gemini.step<string>({
    prompt: [
      `Write the "${section.heading}" section (2 paragraphs, markdown, no top-level heading) for a post about ${topic}.`,
      `Cover: ${section.points.join("; ")}.`,
    ].join("\n"),
    parse: (result) => result.response.trim(),
    validate: (text) => (text.length >= 200 ? null : "too short, expand it"),
    maxAttempts: 2,
    timeoutMs: 180_000,
  });
  drafts.push(`## ${section.heading}\n\n${draft}`);
  console.error(`drafted ${index + 1}/${outline.sections.length}`);
}

// 3. Editor pass on the separate Claude/GPT quota pool.
const markdown = await claude.step<string>({
  prompt: [
    "Polish the blog draft below: tighten sentences, keep all facts, keep markdown, no code fences.",
    "Return the full markdown only.",
    "",
    `# ${outline.title}\n\n${drafts.join("\n\n")}`,
  ].join("\n"),
  parse: (result) => result.response.trim(),
  validate: (text) => (text.includes("```") ? "no code fences allowed" : null),
  maxAttempts: 2,
  timeoutMs: 180_000,
});

const file = "post.md";
await writeFile(file, `${markdown}\n`, "utf8");
console.error(`wrote ${file}`);
