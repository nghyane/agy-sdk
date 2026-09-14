export type AgyErrorKind = "spawn" | "auth" | "quota" | "model" | "timeout" | "protocol" | "run";

const PATTERNS: Array<[RegExp, AgyErrorKind]> = [
  [/quota|RESOURCE_EXHAUSTED|rate limit|429/i, "quota"],
  [/authentication|not logged in|log in|login|oauth|credentials/i, "auth"],
  [/not recognized as a known model|invalid model|model .* not found/i, "model"],
  [/timed? ?out/i, "timeout"],
];

/** Map raw agy output to a typed error kind. Never rely on string matching outside this module. */
export function classifyError(text: string, fallback: AgyErrorKind = "run"): AgyErrorKind {
  for (const [pattern, kind] of PATTERNS) {
    if (pattern.test(text)) return kind;
  }
  return fallback;
}

export class AgyError extends Error {
  readonly kind: AgyErrorKind;
  readonly detail: unknown;

  constructor(kind: AgyErrorKind, message: string, detail?: unknown) {
    super(message);
    this.name = "AgyError";
    this.kind = kind;
    this.detail = detail;
  }
}
