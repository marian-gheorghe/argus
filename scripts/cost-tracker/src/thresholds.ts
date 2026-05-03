export type ThresholdLevel = "none" | "warn" | "page" | "kill";

export interface ThresholdRatios {
  warn: number;
  page: number;
  kill: number;
}

/**
 * Pure: returns the HIGHEST threshold reached at `spent / ceiling`. Comparisons
 * are `>=` so an exact-boundary spend triggers the threshold.
 *
 * Defensive edges:
 * - ceiling <= 0: anything > 0 spent is treated as kill (we can't compute a
 *   ratio, but a zero-ceiling run that has spent anything is unambiguously
 *   over-budget). Spent == 0 with ceiling == 0 returns 'none'.
 * - spent < 0: clamped to 'none'.
 *
 * The caller uses the returned level to drive idempotent emission via
 * Accumulator.markEmitted; this function does NOT remember state.
 */
export function evaluate(spent: number, ceiling: number, ratios: ThresholdRatios): ThresholdLevel {
  if (spent < 0) return "none";
  if (ceiling <= 0) return spent > 0 ? "kill" : "none";
  const ratio = spent / ceiling;
  if (ratio >= ratios.kill) return "kill";
  if (ratio >= ratios.page) return "page";
  if (ratio >= ratios.warn) return "warn";
  return "none";
}
