import { readFileSync } from "node:fs";
import { parseToml } from "./toml.ts";

/** Token-type categories for which we have separate per-token rates. */
export type TokenType = "input" | "cached_input" | "output";

/** Tier names; mirror Anthropic's three model families. */
export type Tier = "haiku" | "sonnet" | "opus";

/**
 * Per-token rates for one tier, in EUR/token (NOT EUR/million-tokens — we do
 * the divide at load time so callers stay in pure-multiplication land).
 */
export interface TierRates {
  input: number;
  cached_input: number;
  output: number;
}

/** Tier → rates map. Used by Pricing.fromObject for tests. */
export type RatesByTier = Record<Tier, TierRates>;

/**
 * Pricing table. Loaded from TOML at `~/.argus/pricing.toml` (path passed in
 * from the hook entrypoint), or constructed in-memory via `fromObject` for
 * tests.
 *
 * Per-token rates are stored as EUR/token (already divided by 1e6 from the
 * EUR/million-tokens TOML representation). This keeps `costFor` a pure
 * multiplication and avoids accumulating divide-then-multiply rounding error
 * across many calls.
 */
export class Pricing {
  private readonly rates: RatesByTier;

  private constructor(rates: RatesByTier) {
    this.rates = rates;
  }

  static load(path: string): Pricing {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Pricing.load: cannot read ${path}: ${msg}`);
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = parseToml(raw);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Pricing.load: invalid TOML in ${path}: ${msg}`);
    }

    const tomlTier = (key: string): string => `claude-${key}`;
    const tiers: Tier[] = ["haiku", "sonnet", "opus"];
    const rates: Partial<RatesByTier> = {};

    for (const tier of tiers) {
      const sectionKey = tomlTier(tier);
      const section = parsed[sectionKey];
      if (section === undefined) {
        // Allow partial pricing tables — `rate()` will throw on lookup if a
        // missing tier is requested. This matches the spec: "missing tier
        // falls back with a clear error".
        continue;
      }
      if (typeof section !== "object" || section === null) {
        throw new Error(`Pricing.load: section [${sectionKey}] must be a table`);
      }
      const sec = section as Record<string, unknown>;
      const requireField = (field: string): number => {
        const v = sec[field];
        if (typeof v !== "number") {
          throw new Error(
            `Pricing.load: section [${sectionKey}] missing or non-numeric field "${field}"`,
          );
        }
        return v;
      };
      const inputPerMillion = requireField("input_eur_per_million");
      const cachedPerMillion = requireField("cached_input_eur_per_million");
      const outputPerMillion = requireField("output_eur_per_million");
      rates[tier] = {
        input: inputPerMillion / 1_000_000,
        cached_input: cachedPerMillion / 1_000_000,
        output: outputPerMillion / 1_000_000,
      };
    }

    return new Pricing(rates as RatesByTier);
  }

  /**
   * Construct a pricing table from a tier→rates map (rates already in
   * EUR/token, NOT EUR/million-tokens). Intended for tests; callers in prod
   * code should use `Pricing.load`.
   */
  static fromObject(rates: RatesByTier): Pricing {
    return new Pricing(rates);
  }

  rate(tier: Tier, type: TokenType): number {
    const tierRates = this.rates[tier];
    if (!tierRates) {
      throw new Error(`Pricing.rate: no rates configured for tier "${tier}"`);
    }
    return tierRates[type];
  }

  /**
   * Compute the EUR cost of a (tier, input, cached, output) token bundle.
   * Pure multiplication: no rounding inside.
   */
  costFor(tier: Tier, input: number, cached: number, output: number): number {
    return (
      input * this.rate(tier, "input") +
      cached * this.rate(tier, "cached_input") +
      output * this.rate(tier, "output")
    );
  }
}
