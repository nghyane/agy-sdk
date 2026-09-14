import type { AgyEvent, RunResult } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Parse one NDJSON line from `agy --output-format stream-json`. Returns null for blank/invalid/unknown lines. */
export function parseEvent(line: string): AgyEvent | null {
  const text = line.trim();
  if (!text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  switch (raw["event"]) {
    case "init":
      if (typeof raw["conversation_id"] === "string" && isRecord(raw["init"])) return raw as unknown as AgyEvent;
      return null;
    case "step_update":
      if (isRecord(raw["step_update"])) return raw as unknown as AgyEvent;
      return null;
    case "result":
      if (isRecord(raw["result"])) return raw as unknown as AgyEvent;
      return null;
    default:
      return null;
  }
}

/** Extract the JSON envelope emitted by `agy -p ... --output-format json` from mixed stdout. */
export function extractEnvelope(text: string): RunResult | null {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line || !line.startsWith("{")) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value) && typeof value["status"] === "string") return value as unknown as RunResult;
    } catch {}
  }
  return null;
}

/** Extract structured output from a result: prefer `structured_output`, fall back to JSON in `response`. */
export function extractStructured<T = unknown>(result: RunResult): T {
  if (result.structured_output !== undefined) return result.structured_output as T;
  const text = stripCodeFence(result.response.trim());
  return JSON.parse(text) as T;
}

export function stripCodeFence(text: string): string {
  const match = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  return match?.[1] ?? text;
}
