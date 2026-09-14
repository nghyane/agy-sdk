export interface QuotaWindow {
  pct: number;
  resetAt: string;
}

export interface QuotaPool {
  weekly?: QuotaWindow;
  fiveHour?: QuotaWindow;
}

export interface QuotaPools {
  gemini: QuotaPool;
  claude: QuotaPool;
}

export type QuotaPoolName = keyof QuotaPools;

const POOL_NAMES: Array<[string, QuotaPoolName]> = [
  ["gemini models", "gemini"],
  ["claude and gpt models", "claude"],
];

/** Parse the tab/space separated output of `agy -p /usage`. */
export function parseUsage(text: string): QuotaPools {
  const pools: QuotaPools = { gemini: {}, claude: {} };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cells = line.includes("\t") ? line.split(/\t+/) : line.split(/\s{2,}/);
    if (cells.length < 4) continue;
    const [poolName, metric, pctRaw, resetAt] = cells;
    const pool = POOL_NAMES.find(([name]) => poolName?.trim().toLowerCase() === name)?.[1];
    if (!pool) continue;
    const pct = Number(String(pctRaw).replace("%", "").trim());
    if (!Number.isFinite(pct)) continue;
    const field = /weekly/i.test(metric ?? "") ? "weekly" : /five hour/i.test(metric ?? "") ? "fiveHour" : null;
    if (!field || !resetAt) continue;
    pools[pool][field] = { pct, resetAt: resetAt.trim() };
  }
  return pools;
}

/** Lowest remaining percentage across both windows of a pool, or null when unknown. */
export function remainingPct(pools: QuotaPools, pool: QuotaPoolName): number | null {
  const value = pools[pool];
  const values = [value.weekly?.pct, value.fiveHour?.pct].filter((v): v is number => v !== undefined);
  return values.length > 0 ? Math.min(...values) : null;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${seconds}s`;
}
